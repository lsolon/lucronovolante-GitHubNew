import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Entry, Category } from '../types';
import { parseEntryDate } from './utils';

export interface ReportExportOptions {
  periodLabel: string;
  periodType: 'daily' | 'weekly' | 'monthly' | 'yearly';
  selectedDate: Date;
  totals: {
    earnings: number;
    expenses: number;
    balance: number;
    kmPercorrido: number;
  };
  entries: Entry[];
  categories: Category[];
  earningCategories: Category[];
  refundCategories?: Category[];
  categoryBreakdown: {
    breakdown: Array<{ id: string; name: string; amount: number; percentage: number }>;
    totalExpenses: number;
  };
  reportData: Array<{
    name: string;
    fullDate: string;
    Ganhos: number;
    Despesas: number;
    Saldo: number;
    kmPercorrido: number;
    entries: Entry[];
  }>;
}

const formatBRL = (val: number) => {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);
};

const sanitizeFileName = (str: string) => {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_');
};

/**
 * Normaliza os lançamentos do período para uma lista linear clara
 */
export function getFlattenedPeriodEntries(options: ReportExportOptions) {
  const { reportData, categories, earningCategories, refundCategories } = options;
  const allPeriodEntries: Entry[] = [];
  const seenIds = new Set<string>();

  // Coleta entradas na ordem cronológica
  reportData.forEach(item => {
    item.entries.forEach(e => {
      if (!seenIds.has(e.id)) {
        seenIds.add(e.id);
        allPeriodEntries.push(e);
      }
    });
  });

  // Ordena por data (mais recente primeiro ou cronológico)
  allPeriodEntries.sort((a, b) => {
    const timeA = parseEntryDate(a.data).getTime();
    const timeB = parseEntryDate(b.data).getTime();
    return timeA - timeB;
  });

  const flattened: Array<{
    id: string;
    data: string;
    dateObj: Date;
    tipo: 'Ganhos' | 'Despesa';
    categoria: string;
    valor: number;
    km?: number;
    obs?: string;
  }> = [];

  allPeriodEntries.forEach(entry => {
    const dateFormatted = format(parseEntryDate(entry.data), 'dd/MM/yyyy');
    const dateObj = parseEntryDate(entry.data);

    if (entry.tipo === 'Ganhos') {
      let expanded = false;
      if (entry.ganhos) {
        Object.entries(entry.ganhos).forEach(([platformId, val]) => {
          if (!val) return;
          const plat = earningCategories.find(c => c.id === platformId);
          flattened.push({
            id: `${entry.id}-${platformId}`,
            data: dateFormatted,
            dateObj,
            tipo: 'Ganhos',
            categoria: plat?.nome || 'Outros Ganhos',
            valor: Number(val),
            km: entry.km,
            obs: entry.obs
          });
          expanded = true;
        });
      }
      if (entry.reembolsos) {
        Object.entries(entry.reembolsos).forEach(([refundId, val]) => {
          if (!val) return;
          const ref = refundCategories?.find(c => c.id === refundId);
          flattened.push({
            id: `${entry.id}-ref-${refundId}`,
            data: dateFormatted,
            dateObj,
            tipo: 'Ganhos',
            categoria: ref ? `Reembolso (${ref.nome})` : 'Reembolso',
            valor: Number(val),
            km: entry.km,
            obs: entry.obs
          });
          expanded = true;
        });
      }
      if (!expanded) {
        flattened.push({
          id: entry.id,
          data: dateFormatted,
          dateObj,
          tipo: 'Ganhos',
          categoria: 'Fechamento do Dia',
          valor: Number(entry.valor || 0),
          km: entry.km,
          obs: entry.obs
        });
      }
    } else {
      const cat = categories.find(c => c.id === entry.categoriaId);
      const isNamed = entry.categoriaId && entry.categoriaId.length > 2 && isNaN(Number(entry.categoriaId));
      flattened.push({
        id: entry.id,
        data: dateFormatted,
        dateObj,
        tipo: 'Despesa',
        categoria: cat?.nome || (isNamed ? entry.categoriaId : 'Despesa Geral'),
        valor: Number(entry.valor || 0),
        km: entry.km,
        obs: entry.obs
      });
    }
  });

  return flattened;
}

/**
 * Calcula ganhos agrupados por plataforma para o balanço
 */
export function getEarningsByPlatform(options: ReportExportOptions) {
  const flattened = getFlattenedPeriodEntries(options);
  const platformMap: Record<string, number> = {};
  let totalEarnings = 0;

  flattened.filter(e => e.tipo === 'Ganhos').forEach(e => {
    platformMap[e.categoria] = (platformMap[e.categoria] || 0) + e.valor;
    totalEarnings += e.valor;
  });

  const list = Object.entries(platformMap).map(([name, amount]) => ({
    name,
    amount,
    percentage: totalEarnings > 0 ? (amount / totalEarnings) * 100 : 0
  })).sort((a, b) => b.amount - a.amount);

  return { list, totalEarnings };
}

/**
 * 1. EXPORTAÇÃO EM PDF FORMATADO
 */
export function exportReportToPDF(options: ReportExportOptions) {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 14;
  let currentY = 16;

  const nowFormatted = format(new Date(), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR });
  const flattenedEntries = getFlattenedPeriodEntries(options);
  const earningsByPlat = getEarningsByPlatform(options);
  const { totals, categoryBreakdown, periodLabel } = options;

  // Cabeçalho Principal com Banner Superior
  doc.setFillColor(37, 99, 235); // Blue 600
  doc.rect(0, 0, pageWidth, 28, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text('LUCRO NO VOLANTE', margin, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(224, 231, 255); // Blue 100
  doc.text(`Balanço Financeiro - ${periodLabel}`, margin, 18);
  doc.setFontSize(8);
  doc.text(`Gerado em: ${nowFormatted} | lucronovolante.app.br`, margin, 24);

  // Badge no canto direito do cabeçalho
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(pageWidth - margin - 35, 8, 35, 12, 3, 3, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(37, 99, 235);
  doc.text('RELATÓRIO OFICIAL', pageWidth - margin - 32, 15);

  currentY = 34;

  // Quadro de Indicadores (KPIs)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42); // Slate 900
  doc.text('Resumo do Balanço', margin, currentY);
  currentY += 4;

  const kpiWidth = (pageWidth - (margin * 2) - 9) / 4;
  const kpiHeight = 18;

  // Card 1: Ganhos
  doc.setFillColor(240, 253, 244); // Emerald 50
  doc.setDrawColor(187, 247, 208); // Emerald 200
  doc.roundedRect(margin, currentY, kpiWidth, kpiHeight, 2, 2, 'FD');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(5, 150, 105); // Emerald 600
  doc.text('GANHOS BRUTOS', margin + 3, currentY + 5);
  doc.setFontSize(10);
  doc.setTextColor(6, 95, 70); // Emerald 800
  doc.text(formatBRL(totals.earnings), margin + 3, currentY + 12);

  // Card 2: Despesas
  const kpi2X = margin + kpiWidth + 3;
  doc.setFillColor(255, 241, 242); // Rose 50
  doc.setDrawColor(254, 205, 211); // Rose 200
  doc.roundedRect(kpi2X, currentY, kpiWidth, kpiHeight, 2, 2, 'FD');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(225, 29, 72); // Rose 600
  doc.text('DESPESAS TOTAIS', kpi2X + 3, currentY + 5);
  doc.setFontSize(10);
  doc.setTextColor(159, 18, 57); // Rose 800
  doc.text(formatBRL(totals.expenses), kpi2X + 3, currentY + 12);

  // Card 3: Saldo Líquido
  const kpi3X = margin + (kpiWidth * 2) + 6;
  const isPositive = totals.balance >= 0;
  doc.setFillColor(isPositive ? 236 : 255, isPositive ? 253 : 241, isPositive ? 245 : 242);
  doc.setDrawColor(isPositive ? 167 : 254, isPositive ? 243 : 205, isPositive ? 208 : 211);
  doc.roundedRect(kpi3X, currentY, kpiWidth, kpiHeight, 2, 2, 'FD');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(isPositive ? 4 : 225, isPositive ? 120 : 29, isPositive ? 87 : 72);
  doc.text('LUCRO LÍQUIDO', kpi3X + 3, currentY + 5);
  doc.setFontSize(10);
  doc.setTextColor(isPositive ? 6 : 159, isPositive ? 95 : 18, isPositive ? 70 : 57);
  doc.text(formatBRL(totals.balance), kpi3X + 3, currentY + 12);

  // Card 4: KM e Eficiência
  const kpi4X = margin + (kpiWidth * 3) + 9;
  doc.setFillColor(239, 246, 255); // Blue 50
  doc.setDrawColor(191, 219, 254); // Blue 200
  doc.roundedRect(kpi4X, currentY, kpiWidth, kpiHeight, 2, 2, 'FD');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(37, 99, 235); // Blue 600
  doc.text('KM RODADO', kpi4X + 3, currentY + 5);
  doc.setFontSize(10);
  doc.setTextColor(30, 58, 138); // Blue 900
  doc.text(`${totals.kmPercorrido.toLocaleString('pt-BR')} km`, kpi4X + 3, currentY + 12);

  currentY += kpiHeight + 8;

  // Linha de métricas secundárias (Margem de Lucro e Rentabilidade/km)
  const marginPct = totals.earnings > 0 ? ((totals.balance / totals.earnings) * 100).toFixed(1) : '0.0';
  const rentabilidadeKm = totals.kmPercorrido > 0 ? (totals.earnings / totals.kmPercorrido).toFixed(2) : '0,00';
  const custoKm = totals.kmPercorrido > 0 ? (totals.expenses / totals.kmPercorrido).toFixed(2) : '0,00';

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Margem Líquida: ${marginPct}%  |  Rentabilidade Média: R$ ${rentabilidadeKm}/km  |  Custo Operacional: R$ ${custoKm}/km`,
    margin,
    currentY
  );
  currentY += 6;

  // Tabelas Lado a Lado ou Sequenciais para Ganhos e Despesas
  const halfTableWidth = (pageWidth - (margin * 2) - 6) / 2;

  // Tabela de Ganhos por Plataforma
  const earningsHead = [['Plataforma / Origem', 'Valor', 'Part.']];
  const earningsBody = earningsByPlat.list.length > 0 
    ? earningsByPlat.list.map(p => [p.name, formatBRL(p.amount), `${p.percentage.toFixed(1)}%`])
    : [['Sem registros no período', 'R$ 0,00', '0%']];

  autoTable(doc, {
    startY: currentY,
    margin: { left: margin, right: margin + halfTableWidth + 6 },
    head: earningsHead,
    body: earningsBody,
    theme: 'striped',
    headStyles: {
      fillColor: [5, 150, 105],
      textColor: [255, 255, 255],
      fontSize: 8,
      fontStyle: 'bold',
      halign: 'left'
    },
    styles: {
      fontSize: 7.5,
      cellPadding: 2,
      textColor: [30, 41, 59]
    },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', fontStyle: 'bold' },
      2: { halign: 'right' }
    }
  });

  const earningsTableFinalY = (doc as any).lastAutoTable.finalY;

  // Tabela de Despesas por Categoria
  const expensesHead = [['Categoria Despesa', 'Valor', 'Part.']];
  const expensesBody = categoryBreakdown.breakdown.length > 0
    ? categoryBreakdown.breakdown.map(c => [c.name, formatBRL(c.amount), `${c.percentage.toFixed(1)}%`])
    : [['Sem despesas no período', 'R$ 0,00', '0%']];

  autoTable(doc, {
    startY: currentY,
    margin: { left: margin + halfTableWidth + 6, right: margin },
    head: expensesHead,
    body: expensesBody,
    theme: 'striped',
    headStyles: {
      fillColor: [225, 29, 72],
      textColor: [255, 255, 255],
      fontSize: 8,
      fontStyle: 'bold',
      halign: 'left'
    },
    styles: {
      fontSize: 7.5,
      cellPadding: 2,
      textColor: [30, 41, 59]
    },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', fontStyle: 'bold' },
      2: { halign: 'right' }
    }
  });

  const expensesTableFinalY = (doc as any).lastAutoTable.finalY;
  currentY = Math.max(earningsTableFinalY, expensesTableFinalY) + 8;

  // Tabela de Extrato de Lançamentos
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('Extrato Detalhado de Lançamentos', margin, currentY);
  currentY += 3;

  const entriesHead = [['Data', 'Tipo', 'Categoria / Plataforma', 'KM', 'Observações', 'Valor']];
  const entriesBody = flattenedEntries.map(e => [
    e.data,
    e.tipo,
    e.categoria,
    e.km ? `${e.km}` : '-',
    e.obs || '-',
    formatBRL(e.valor)
  ]);

  autoTable(doc, {
    startY: currentY,
    margin: { left: margin, right: margin, bottom: 18 },
    head: entriesHead,
    body: entriesBody.length > 0 ? entriesBody : [['-', '-', 'Nenhum lançamento encontrado', '-', '-', 'R$ 0,00']],
    theme: 'grid',
    headStyles: {
      fillColor: [30, 41, 59], // Slate 800
      textColor: [255, 255, 255],
      fontSize: 8,
      fontStyle: 'bold'
    },
    styles: {
      fontSize: 7.5,
      cellPadding: 2.2,
      textColor: [51, 65, 85]
    },
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 18, fontStyle: 'bold' },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 18, halign: 'center' },
      4: { cellWidth: 42 },
      5: { cellWidth: 26, halign: 'right', fontStyle: 'bold' }
    },
    didParseCell: (data) => {
      if (data.section === 'body') {
        if (data.column.index === 1) {
          const text = data.cell.raw as string;
          if (text === 'Ganhos') {
            data.cell.styles.textColor = [5, 150, 105]; // emerald
          } else if (text === 'Despesa') {
            data.cell.styles.textColor = [225, 29, 72]; // rose
          }
        }
        if (data.column.index === 5) {
          const rowData = data.row.raw as any[];
          const tipo = rowData[1];
          if (tipo === 'Ganhos') {
            data.cell.styles.textColor = [5, 150, 105];
          } else if (tipo === 'Despesa') {
            data.cell.styles.textColor = [225, 29, 72];
          }
        }
      }
    },
    didDrawPage: (data) => {
      // Rodapé da página
      const pageNum = (doc as any).internal.getNumberOfPages();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(148, 163, 184); // Slate 400
      doc.text(
        'Lucro no Volante - Gestão Financeira para Motoristas de Aplicativo | lucronovolante.app.br',
        margin,
        pageHeight - 8
      );
      doc.text(
        `Página ${data.pageNumber} de ${pageNum}`,
        pageWidth - margin - 20,
        pageHeight - 8
      );
    }
  });

  // Salva o arquivo PDF
  const filename = `Balanco_LucroNoVolante_${sanitizeFileName(periodLabel)}.pdf`;
  doc.save(filename);
}

/**
 * 2. EXPORTAÇÃO EM CSV (Compatível com Excel pt-BR / Google Sheets com UTF-8 BOM e delimitador ';')
 */
export function exportReportToCSV(options: ReportExportOptions) {
  const { periodLabel, totals, categoryBreakdown } = options;
  const flattened = getFlattenedPeriodEntries(options);
  const earningsByPlat = getEarningsByPlatform(options);
  const nowFormatted = format(new Date(), 'dd/MM/yyyy HH:mm', { locale: ptBR });

  const escapeCsv = (str: string | number | undefined | null) => {
    if (str === undefined || str === null) return '""';
    const val = String(str).replace(/"/g, '""');
    return `"${val}"`;
  };

  const formatNumberPtBR = (num: number) => {
    return num.toFixed(2).replace('.', ',');
  };

  const lines: string[] = [];

  // Cabeçalho de Identificação
  lines.push('LUCRO NO VOLANTE - BALANÇO FINANCEIRO');
  lines.push(`Período Selecionado;${escapeCsv(periodLabel)}`);
  lines.push(`Data de Exportação;${escapeCsv(nowFormatted)}`);
  lines.push(`Plataforma;${escapeCsv('lucronovolante.app.br')}`);
  lines.push('');

  // Resumo Geral
  lines.push('--- RESUMO GERAL DO BALANÇO ---');
  lines.push(`Ganhos Brutos (R$);${formatNumberPtBR(totals.earnings)}`);
  lines.push(`Despesas Totais (R$);${formatNumberPtBR(totals.expenses)}`);
  lines.push(`Saldo Líquido / Lucro (R$);${formatNumberPtBR(totals.balance)}`);
  lines.push(`KM Total Rodado;${totals.kmPercorrido}`);
  if (totals.kmPercorrido > 0) {
    lines.push(`Rentabilidade por KM (R$/km);${formatNumberPtBR(totals.earnings / totals.kmPercorrido)}`);
    lines.push(`Custo por KM (R$/km);${formatNumberPtBR(totals.expenses / totals.kmPercorrido)}`);
  }
  lines.push('');

  // Ganhos por Plataforma
  lines.push('--- GANHOS POR PLATAFORMA ---');
  lines.push('Plataforma;Valor (R$);Participação (%)');
  earningsByPlat.list.forEach(p => {
    lines.push(`${escapeCsv(p.name)};${formatNumberPtBR(p.amount)};${formatNumberPtBR(p.percentage)}%`);
  });
  lines.push('');

  // Despesas por Categoria
  lines.push('--- DESPESAS POR CATEGORIA ---');
  lines.push('Categoria;Valor (R$);Participação (%)');
  categoryBreakdown.breakdown.forEach(c => {
    lines.push(`${escapeCsv(c.name)};${formatNumberPtBR(c.amount)};${formatNumberPtBR(c.percentage)}%`);
  });
  lines.push('');

  // Extrato Detalhado de Lançamentos
  lines.push('--- EXTRATO DETALHADO DE LANÇAMENTOS ---');
  lines.push('Data;Tipo;Categoria/Plataforma;Valor (R$);KM Registrado;Observação');
  flattened.forEach(e => {
    lines.push(
      [
        escapeCsv(e.data),
        escapeCsv(e.tipo),
        escapeCsv(e.categoria),
        formatNumberPtBR(e.valor),
        escapeCsv(e.km ? String(e.km) : ''),
        escapeCsv(e.obs || '')
      ].join(';')
    );
  });

  // UTF-8 BOM para garantir acentos perfeitos no Excel brasileiro
  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `Balanco_LucroNoVolante_${sanitizeFileName(periodLabel)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 3. EXPORTAÇÃO EM EXCEL (.xlsx com múltiplas planilhas formatadas)
 */
export function exportReportToExcel(options: ReportExportOptions) {
  const { periodLabel, totals, categoryBreakdown } = options;
  const flattened = getFlattenedPeriodEntries(options);
  const earningsByPlat = getEarningsByPlatform(options);

  const workbook = XLSX.utils.book_new();

  // Aba 1: Resumo do Balanço
  const resumoData = [
    ['LUCRO NO VOLANTE - BALANÇO FINANCEIRO'],
    ['Período:', periodLabel],
    ['Gerado em:', format(new Date(), 'dd/MM/yyyy HH:mm')],
    [],
    ['INDICADORES GERAIS', 'VALOR'],
    ['Ganhos Brutos (R$)', totals.earnings],
    ['Despesas Totais (R$)', totals.expenses],
    ['Saldo Líquido / Lucro (R$)', totals.balance],
    ['KM Percorrido', totals.kmPercorrido],
    ['Rentabilidade Média (R$/km)', totals.kmPercorrido > 0 ? totals.earnings / totals.kmPercorrido : 0],
    ['Custo por KM (R$/km)', totals.kmPercorrido > 0 ? totals.expenses / totals.kmPercorrido : 0],
    [],
    ['GANHOS POR PLATAFORMA', 'VALOR (R$)', 'PARTICIPAÇÃO (%)'],
    ...earningsByPlat.list.map(p => [p.name, p.amount, p.percentage / 100]),
    [],
    ['DESPESAS POR CATEGORIA', 'VALOR (R$)', 'PARTICIPAÇÃO (%)'],
    ...categoryBreakdown.breakdown.map(c => [c.name, c.amount, c.percentage / 100])
  ];

  const wsResumo = XLSX.utils.aoa_to_sheet(resumoData);
  XLSX.utils.book_append_sheet(workbook, wsResumo, 'Resumo do Balanço');

  // Aba 2: Lançamentos Detalhados
  const lancamentosData = [
    ['Data', 'Tipo', 'Categoria / Plataforma', 'Valor (R$)', 'KM', 'Observações'],
    ...flattened.map(e => [
      e.data,
      e.tipo,
      e.categoria,
      e.valor,
      e.km || '',
      e.obs || ''
    ])
  ];

  const wsLancamentos = XLSX.utils.aoa_to_sheet(lancamentosData);
  XLSX.utils.book_append_sheet(workbook, wsLancamentos, 'Lançamentos Detalhados');

  const filename = `Balanco_LucroNoVolante_${sanitizeFileName(periodLabel)}.xlsx`;
  XLSX.writeFile(workbook, filename);
}

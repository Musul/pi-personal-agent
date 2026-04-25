#!/usr/bin/env node
/**
 * @module pi-tool-finanzas
 * @data ~/workspace/finanzas/
 * @user-docs ~/workspace/AGENTS.md#finanzas
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.PI_HOME || os.homedir();
const DATA_DIR = process.env.FINANZAS_DATA_DIR || path.join(HOME, 'workspace', 'finanzas');
const TRANS_CSV = path.join(DATA_DIR, 'transacciones.csv');
const LOANS_CSV = path.join(DATA_DIR, 'prestamos.csv');
const PRESETS_JSON = path.join(DATA_DIR, 'presupuestos.json');
const TASAS_JSON = path.join(DATA_DIR, 'tasas.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');

// FX rate config — secondary currency support is opt-in.
// Set FX_ENABLED=true and provide FX_API_URL / FX_LABEL / FX_SYMBOL to enable.
// Defaults to USD-only mode.
const FX_ENABLED = (process.env.FX_ENABLED || 'false').toLowerCase() === 'true';
const FX_API_URL = process.env.FX_API_URL || '';
const FX_LABEL = process.env.FX_LABEL || 'FX';
const FX_SYMBOL = process.env.FX_SYMBOL || '';

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseFecha(str) {
  if (!str) return hoy();
  // Acepta YYYY-MM-DD o DD/MM/YYYY
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
  return str;
}

function fmtFecha(str) {
  if (!str) return '';
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return str;
}

function csvEscape(s) {
  if (s == null) return '';
  s = String(s);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvLine(arr) {
  return arr.map(csvEscape).join(',') + '\n';
}

function readCsv(file, required = true) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`No existe: ${file}`);
    return [];
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = {};
    const cells = parseCsvLine(lines[i]);
    headers.forEach((h, idx) => row[h] = cells[idx] || '');
    out.push(row);
  }
  return out;
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i+1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        cells.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  cells.push(cur);
  return cells;
}

function appendCsv(file, obj, headers) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, csvLine(headers));
  }
  const row = headers.map(h => obj[h] ?? '');
  fs.appendFileSync(file, csvLine(row));
}

function readJson(file, def = {}) {
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

async function fetchTasa() {
  if (!FX_ENABLED) return { tasa: 1, fecha: hoy(), fuente: 'fx-disabled' };
  try {
    const res = await fetch(FX_API_URL, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const tasa = parseFloat(data.promedio || data.venta || data.compra || data.precio || data.rate || data.value);
    if (!tasa || isNaN(tasa)) throw new Error('Tasa inválida');
    const fechaStr = data.fechaActualizacion ? data.fechaActualizacion.slice(0,10) : (data.fecha || hoy());
    return { tasa, fecha: fechaStr, fuente: data.fuente || FX_LABEL };
  } catch (e) {
    throw new Error(`No pude consultar FX (${FX_API_URL}): ${e.message}`);
  }
}

async function getTasaFx(force = false) {
  if (!FX_ENABLED) return { tasa: 1, fecha: hoy(), cached: true };
  const tasas = readJson(TASAS_JSON, {});
  const today = hoy();
  if (!force && tasas[today]) {
    return { tasa: tasas[today].tasa, fecha: today, cached: true };
  }
  const info = await fetchTasa();
  tasas[today] = { tasa: info.tasa, fuente: info.fuente, consulta: new Date().toISOString() };
  writeJson(TASAS_JSON, tasas);
  return { tasa: info.tasa, fecha: today, cached: false };
}

function detectMoneda(str) {
  const s = String(str).toLowerCase();
  if (FX_SYMBOL && s.includes(FX_SYMBOL.toLowerCase())) return FX_SYMBOL;
  if (s.includes('$') || s.includes('usd') || s.includes('dolar')) return 'USD';
  return null;
}

function parseMonto(str) {
  // Elimina símbolos y espacios
  const clean = String(str).replace(/[$\s]/g, '').replace(/,/g, '.');
  const val = parseFloat(clean);
  if (isNaN(val)) throw new Error(`Monto inválido: ${str}`);
  return val;
}

function fmtUsd(n) {
  if (n == null || n === '') return '';
  return '$' + Number(n).toFixed(2);
}

function fmtBs(n) {
  if (n == null || n === '') return '';
  return Number(n).toFixed(2) + ' ' + FX_SYMBOL;
}

function getPresupuestos() {
  return readJson(PRESETS_JSON, {});
}

function gastoDelMes(categoria, fechaRef) {
  const [year, month] = fechaRef.split('-');
  const trans = readCsv(TRANS_CSV);
  let sum = 0;
  for (const t of trans) {
    if (t.categoria !== categoria) continue;
    if (t.tipo !== 'gasto') continue;
    const f = t.fecha || '';
    if (!f.startsWith(`${year}-${month}`)) continue;
    sum += Math.abs(parseFloat(t.monto_usd || 0));
  }
  return sum;
}

function alertaPresupuesto(categoria, fechaRef) {
  const pres = getPresupuestos();
  const limite = pres[categoria];
  if (!limite) return null;
  const gastado = gastoDelMes(categoria, fechaRef);
  const pct = (gastado / limite) * 100;
  if (pct >= 100) return `🚨 ${categoria}: ${fmtUsd(gastado)}/${fmtUsd(limite)} (${pct.toFixed(0)}%)`;
  if (pct >= 80) return `⚠️ ${categoria}: ${fmtUsd(gastado)}/${fmtUsd(limite)} (${pct.toFixed(0)}%)`;
  return `✅ ${categoria}: ${fmtUsd(gastado)}/${fmtUsd(limite)} (${pct.toFixed(0)}%)`;
}

async function cmdAdd(argv) {
  const descripcion = argv._[1];
  const montoRaw = argv._[2];
  if (!descripcion || !montoRaw) {
    console.log(JSON.stringify({ ok: false, error: 'Uso: add <descripcion> <monto> [--cat <cat>] [--tipo ingreso|gasto] [--moneda USD|Bs] [--fecha YYYY-MM-DD] [--notas <notas>]' }));
    process.exit(1);
  }

  let moneda = argv.moneda || detectMoneda(montoRaw) || detectMoneda(descripcion) || 'USD';
  const monto = parseMonto(montoRaw);
  const fecha = parseFecha(argv.fecha);
  const categoria = argv.cat || argv.categoria || 'gastos-hormiga';
  const tipo = argv.tipo || 'gasto';
  const notas = argv.notas || '';

  // Determinar monto_usd y monto_bs
  let monto_usd, monto_bs;
  const info = await getTasaFx();
  const tasa = info.tasa;

  if (moneda === 'Bs') {
    monto_bs = monto;
    monto_usd = +(monto / tasa).toFixed(4);
  } else {
    monto_usd = monto;
    monto_bs = +(monto * tasa).toFixed(2);
  }

  const row = { fecha, descripcion: descripcion.replace(/[$\d\s]+$/,'').trim() || descripcion, monto_usd, monto_bs, moneda_origen: moneda, tasa, categoria, tipo, notas };
  appendCsv(TRANS_CSV, row, ['fecha','descripcion','monto_usd','monto_bs','moneda_origen','tasa','categoria','tipo','notas']);

  const alerta = tipo === 'gasto' ? alertaPresupuesto(categoria, fecha) : null;

  console.log(JSON.stringify({
    ok: true,
    msg: `Registrado: ${descripcion} ${moneda==='Bs' ? fmtBs(monto_bs) : fmtUsd(monto_usd)} (${fmtBs(monto_bs)})`,
    tasa: `Tasa ${FX_LABEL} ${fecha}: ${tasa.toFixed(2)} ${FX_SYMBOL}/$`,
    alerta,
    row
  }, null, 2));
}

async function cmdLoanAdd(argv) {
  const persona = argv._[1];
  const montoRaw = argv._[2];
  const descripcion = argv._[3] || `Préstamo a ${persona}`;
  if (!persona || !montoRaw) {
    console.log(JSON.stringify({ ok: false, error: 'Uso: loan-add <persona> <monto> [descripcion] [--moneda USD|Bs] [--fecha YYYY-MM-DD]' }));
    process.exit(1);
  }

  let moneda = argv.moneda || detectMoneda(montoRaw) || 'USD';
  const monto = parseMonto(montoRaw);
  const fecha = parseFecha(argv.fecha);

  const info = await getTasaFx();
  const tasa = info.tasa;
  let monto_usd, monto_bs;
  if (moneda === 'Bs') {
    monto_bs = monto;
    monto_usd = +(monto / tasa).toFixed(4);
  } else {
    monto_usd = monto;
    monto_bs = +(monto * tasa).toFixed(2);
  }

  // Generar ID simple
  const loans = readCsv(LOANS_CSV, false);
  const id = loans.length > 0 ? Math.max(...loans.map(l => parseInt(l.id)||0)) + 1 : 1;

  const row = { id, persona, monto_original: monto_usd, saldo: monto_usd, fecha, descripcion, estado: 'pendiente' };
  appendCsv(LOANS_CSV, row, ['id','persona','monto_original','saldo','fecha','descripcion','estado']);

  // Registrar también como transacción tipo gasto
  const trans = { fecha, descripcion: `Préstamo ${persona}: ${descripcion}`, monto_usd, monto_bs, moneda_origen: moneda, tasa, categoria: `prestamo-${persona.toLowerCase()}`, tipo: 'gasto', notas: `loan_id:${id}` };
  appendCsv(TRANS_CSV, trans, ['fecha','descripcion','monto_usd','monto_bs','moneda_origen','tasa','categoria','tipo','notas']);

  console.log(JSON.stringify({
    ok: true,
    msg: `Préstamo #${id} a ${persona}: ${fmtUsd(monto_usd)}`,
    row
  }, null, 2));
}

function cmdLoanList() {
  const loans = readCsv(LOANS_CSV, false);
  const pendientes = loans.filter(l => l.estado === 'pendiente');
  const porPersona = {};
  for (const l of pendientes) {
    porPersona[l.persona] = (porPersona[l.persona] || 0) + parseFloat(l.saldo || 0);
  }
  console.log(JSON.stringify({
    ok: true,
    total_prestamos: pendientes.length,
    total_saldo: +pendientes.reduce((a,b)=>a+parseFloat(b.saldo||0),0).toFixed(2),
    por_persona: porPersona,
    detalle: pendientes
  }, null, 2));
}

async function cmdLoanPay(argv) {
  const id = parseInt(argv._[1]);
  const montoRaw = argv._[2];
  if (!id || !montoRaw) {
    console.log(JSON.stringify({ ok: false, error: 'Uso: loan-pay <id> <monto> [--moneda USD|Bs] [--fecha YYYY-MM-DD]' }));
    process.exit(1);
  }

  let moneda = argv.moneda || detectMoneda(montoRaw) || 'USD';
  const monto = parseMonto(montoRaw);
  const fecha = parseFecha(argv.fecha);

  const info = await getTasaFx();
  const tasa = info.tasa;
  let monto_usd, monto_bs;
  if (moneda === 'Bs') {
    monto_bs = monto;
    monto_usd = +(monto / tasa).toFixed(4);
  } else {
    monto_usd = monto;
    monto_bs = +(monto * tasa).toFixed(2);
  }

  let loans = readCsv(LOANS_CSV, false);
  const idx = loans.findIndex(l => parseInt(l.id) === id);
  if (idx === -1) {
    console.log(JSON.stringify({ ok: false, error: `Préstamo #${id} no encontrado` }));
    process.exit(1);
  }

  const loan = loans[idx];
  const saldoAnt = parseFloat(loan.saldo || 0);
  const nuevoSaldo = +(saldoAnt - monto_usd).toFixed(4);
  loans[idx].saldo = nuevoSaldo > 0 ? nuevoSaldo : 0;
  loans[idx].estado = nuevoSaldo <= 0 ? 'pagado' : 'pendiente';

  // Reescribir CSV
  const headers = ['id','persona','monto_original','saldo','fecha','descripcion','estado'];
  let out = csvLine(headers);
  for (const l of loans) {
    out += csvLine(headers.map(h => l[h] ?? ''));
  }
  fs.writeFileSync(LOANS_CSV, out);

  // Registrar transacción de ingreso (me devolvieron)
  const trans = { fecha, descripcion: `Cobro préstamo #${id} ${loan.persona}`, monto_usd, monto_bs, moneda_origen: moneda, tasa, categoria: `prestamo-${loan.persona.toLowerCase()}`, tipo: 'ingreso', notas: `loan_id:${id}` };
  appendCsv(TRANS_CSV, trans, ['fecha','descripcion','monto_usd','monto_bs','moneda_origen','tasa','categoria','tipo','notas']);

  console.log(JSON.stringify({
    ok: true,
    msg: `Préstamo #${id} ${loan.persona}: abono ${fmtUsd(monto_usd)}. Saldo: ${fmtUsd(loans[idx].saldo)}`,
    estado: loans[idx].estado
  }, null, 2));
}

function cmdSearch(argv) {
  const query = argv._[1];
  const trans = readCsv(TRANS_CSV);
  let results = trans;

  if (query) {
    const q = query.toLowerCase();
    results = results.filter(t =>
      (t.descripcion || '').toLowerCase().includes(q) ||
      (t.categoria || '').toLowerCase().includes(q) ||
      (t.notas || '').toLowerCase().includes(q) ||
      (t.monto_usd || '').includes(q) ||
      (t.monto_bs || '').includes(q)
    );
  }
  if (argv.cat) {
    results = results.filter(t => t.categoria === argv.cat);
  }
  if (argv.tipo) {
    results = results.filter(t => t.tipo === argv.tipo);
  }
  if (argv.desde) {
    const d = parseFecha(argv.desde);
    results = results.filter(t => (t.fecha || '') >= d);
  }
  if (argv.hasta) {
    const d = parseFecha(argv.hasta);
    results = results.filter(t => (t.fecha || '') <= d);
  }

  // Ordenar por fecha descendente
  results.sort((a,b) => (b.fecha||'').localeCompare(a.fecha||''));

  console.log(JSON.stringify({
    ok: true,
    count: results.length,
    results: results.slice(0, 50) // límite para no saturar
  }, null, 2));
}

function cmdBalance(argv) {
  const trans = readCsv(TRANS_CSV);
  const month = argv.mes || hoy().slice(0,7); // YYYY-MM
  let ingresos = 0, gastos = 0;
  for (const t of trans) {
    if (!t.fecha || !t.fecha.startsWith(month)) continue;
    const usd = parseFloat(t.monto_usd || 0);
    if (t.tipo === 'ingreso') ingresos += usd;
    else if (t.tipo === 'gasto') gastos += Math.abs(usd);
  }
  // Balance total histórico
  let totalIngresos = 0, totalGastos = 0;
  for (const t of trans) {
    const usd = parseFloat(t.monto_usd || 0);
    if (t.tipo === 'ingreso') totalIngresos += usd;
    else if (t.tipo === 'gasto') totalGastos += Math.abs(usd);
  }

  console.log(JSON.stringify({
    ok: true,
    mes: month,
    mes_ingresos: +ingresos.toFixed(2),
    mes_gastos: +gastos.toFixed(2),
    mes_balance: +(ingresos - gastos).toFixed(2),
    historico_ingresos: +totalIngresos.toFixed(2),
    historico_gastos: +totalGastos.toFixed(2),
    historico_balance: +(totalIngresos - totalGastos).toFixed(2)
  }, null, 2));
}

async function cmdReport(argv) {
  const month = argv._[1] || hoy().slice(0,7);
  const [year, mon] = month.split('-');
  const mesNombre = new Date(`${year}-${mon}-01`).toLocaleString('es-VE', { month: 'long', year: 'numeric' });

  const trans = readCsv(TRANS_CSV);
  const pres = getPresupuestos();

  let ingresos = 0, gastos = 0;
  const porCategoria = {};
  const porTipo = {};
  let tasaSum = 0, tasaCount = 0;

  for (const t of trans) {
    if (!t.fecha || !t.fecha.startsWith(month)) continue;
    const usd = parseFloat(t.monto_usd || 0);
    if (t.tipo === 'ingreso') ingresos += usd;
    else if (t.tipo === 'gasto') gastos += Math.abs(usd);

    const cat = t.categoria || 'sin-categoria';
    if (t.tipo === 'gasto') {
      porCategoria[cat] = (porCategoria[cat] || 0) + Math.abs(usd);
    }
    porTipo[t.tipo] = (porTipo[t.tipo] || 0) + usd;

    const tasa = parseFloat(t.tasa || 0);
    if (tasa > 0) { tasaSum += tasa; tasaCount++; }
  }

  const tasaProm = tasaCount > 0 ? (tasaSum / tasaCount).toFixed(2) : 'N/A';

  // Préstamos pendientes al final del mes
  const loans = readCsv(LOANS_CSV, false);
  const pendientes = loans.filter(l => l.estado === 'pendiente');

  // Generar markdown
  let md = `# Reporte Financiero - ${mesNombre}\n\n`;
  md += `## Resumen\n\n`;
  md += `- **Ingresos:** ${fmtUsd(ingresos)}\n`;
  md += `- **Gastos:** ${fmtUsd(gastos)}\n`;
  md += `- **Balance:** ${fmtUsd(ingresos - gastos)}\n`;
  md += `- **Tasa ${FX_LABEL} promedio:** ${tasaProm} ${FX_SYMBOL}/$\n\n`;

  md += `## Gastos por Categoría vs Presupuesto\n\n`;
  md += `| Categoría | Gastado | Presupuesto | % | Estado |\n`;
  md += `|-----------|---------|-------------|---|--------|\n`;
  const cats = Object.keys(porCategoria).sort();
  for (const cat of cats) {
    const gastado = porCategoria[cat];
    const limite = pres[cat];
    if (limite) {
      const pct = (gastado / limite) * 100;
      const estado = pct >= 100 ? '🚨' : pct >= 80 ? '⚠️' : '✅';
      md += `| ${cat} | ${fmtUsd(gastado)} | ${fmtUsd(limite)} | ${pct.toFixed(0)}% | ${estado} |\n`;
    } else {
      md += `| ${cat} | ${fmtUsd(gastado)} | - | - | - |\n`;
    }
  }
  if (cats.length === 0) md += `| (sin gastos) | - | - | - | - |\n`;

  md += `\n## Préstamos Pendientes\n\n`;
  if (pendientes.length === 0) {
    md += `No hay préstamos pendientes.\n`;
  } else {
    md += `| ID | Persona | Monto Original | Saldo | Fecha | Descripción |\n`;
    md += `|----|---------|----------------|-------|-------|-------------|\n`;
    for (const l of pendientes) {
      md += `| ${l.id} | ${l.persona} | ${fmtUsd(l.monto_original)} | ${fmtUsd(l.saldo)} | ${fmtFecha(l.fecha)} | ${l.descripcion} |\n`;
    }
  }

  md += `\n---\n*Generado el ${fmtFecha(hoy())}*\n`;

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${month}.md`);
  fs.writeFileSync(file, md);

  console.log(JSON.stringify({
    ok: true,
    msg: `Reporte generado: ${file}`,
    mes: month,
    ingresos: fmtUsd(ingresos),
    gastos: fmtUsd(gastos),
    balance: fmtUsd(ingresos - gastos)
  }, null, 2));
}

function cmdBootstrap() {
  const TEMPLATES = path.join(__dirname, 'templates');
  const INV_DIR = path.join(DATA_DIR, 'inversiones');
  if (!fs.existsSync(INV_DIR)) fs.mkdirSync(INV_DIR, { recursive: true });
  const targets = [
    { src: path.join(TEMPLATES, 'transacciones.csv'),           dst: TRANS_CSV },
    { src: path.join(TEMPLATES, 'prestamos.csv'),               dst: LOANS_CSV },
    { src: path.join(TEMPLATES, 'presupuestos.json'),           dst: PRESETS_JSON },
    { src: path.join(TEMPLATES, 'inversiones', 'operaciones.csv'), dst: path.join(INV_DIR, 'operaciones.csv') },
    { src: path.join(TEMPLATES, 'inversiones', 'activos.json'),    dst: path.join(INV_DIR, 'activos.json') }
  ];
  const created = [], skipped = [], missingTemplate = [];
  for (const { src, dst } of targets) {
    if (fs.existsSync(dst)) { skipped.push(dst); continue; }
    if (!fs.existsSync(src)) { missingTemplate.push(src); continue; }
    fs.copyFileSync(src, dst);
    created.push(dst);
  }
  console.log(JSON.stringify({ ok: true, msg: 'Templates copied. Edit values in the new files.', created, skipped, missingTemplate }, null, 2));
}

async function cmdTasa() {
  const info = await getTasaFx(true);
  console.log(JSON.stringify({
    ok: true,
    tasa: info.tasa,
    fecha: info.fecha,
    cached: info.cached,
    msg: `Tasa ${FX_LABEL} ${info.fecha}: ${info.tasa.toFixed(2)} ${FX_SYMBOL}/$`
  }, null, 2));
}

// CLI parser simple
function parseArgv(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i+1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0];

  try {
    switch (cmd) {
      case 'add': await cmdAdd(argv); break;
      case 'loan-add': await cmdLoanAdd(argv); break;
      case 'loan-list': cmdLoanList(); break;
      case 'loan-pay': await cmdLoanPay(argv); break;
      case 'search': cmdSearch(argv); break;
      case 'balance': cmdBalance(argv); break;
      case 'report': await cmdReport(argv); break;
      case 'tasa': await cmdTasa(); break;
      case 'bootstrap': cmdBootstrap(); break;
      default:
        console.log(JSON.stringify({ ok: false, error: `Comando desconocido: ${cmd}`, uso: 'Comandos: add, loan-add, loan-list, loan-pay, search, balance, report, tasa, bootstrap' }));
        process.exit(1);
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}

main();

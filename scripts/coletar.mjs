// Coletor diário de preços FLN ⇄ PUQ (outubro/2027) usando a API gratuita do SerpApi (Google Flights).
// Roda no GitHub Actions (Node 20+). Precisa do segredo SERPAPI_KEY.
import { readFile, writeFile } from 'node:fs/promises';

const ARQ = new URL('../data/historico.json', import.meta.url);
const ALERTA = new URL('../data/alerta.txt', import.meta.url);

const ORIGEM = 'FLN';
const DESTINO = 'PUQ';
const DIAS_VIAGEM = 7;            // volta 7 dias depois da ida
const PRIMEIRA_IDA = 1;           // 01/10/2027
const ULTIMA_IDA = 24;            // 24/10/2027 (volta 31/10)
const GRUPOS = 3;                 // a cada dia busca 1/3 das datas -> cada data a cada 3 dias
const LIMITE_MES = 240;           // plano grátis do SerpApi: 250 buscas/mês (deixa folga)
const FIM_MONITOR = '2026-12-31'; // depois desse dia o coletor não busca mais nada
const REFERENCIA = 2471;

const key = process.env.SERPAPI_KEY;
if (!key) { console.error('Falta o segredo SERPAPI_KEY.'); process.exit(1); }

// Data de hoje no horário de Brasília (AAAA-MM-DD)
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
if (hoje > FIM_MONITOR) { console.log(`Monitor encerrado em ${FIM_MONITOR}. Nada a fazer.`); process.exit(0); }

const pad = (n) => String(n).padStart(2, '0');
const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const linkGoogle = (ida, volta) => `https://www.google.com/travel/flights?q=Flights%20to%20${DESTINO}%20from%20${ORIGEM}%20on%20${ida}%20through%20${volta}&hl=pt-BR&curr=BRL`;

let hist = [];
try { hist = JSON.parse((await readFile(ARQ, 'utf8')).replace(/^\uFEFF/, '')); } catch { hist = []; }

// Quantas buscas pagas já foram feitas neste mês
const mes = hoje.slice(0, 7);
const usadasNoMes = hist.filter((r) => r.checked_at?.startsWith(mes) && r.fonte === 'serpapi' && r.contou).length;

// Escolhe as datas de hoje (rodízio)
const diaNum = Math.floor(Date.parse(hoje + 'T12:00:00Z') / 86400000);
const grupo = diaNum % GRUPOS;
const forcar = process.env.TODAS_AS_DATAS === 'true';
const idas = [];
for (let d = PRIMEIRA_IDA; d <= ULTIMA_IDA; d++) {
  if (forcar || (d - PRIMEIRA_IDA) % GRUPOS === grupo) idas.push(`2027-10-${pad(d)}`);
}

const restantes = LIMITE_MES - usadasNoMes;
if (restantes <= 0) { console.log(`Limite do mês atingido (${usadasNoMes} buscas). Nada a fazer hoje.`); process.exit(0); }
const lote = idas.slice(0, restantes);
console.log(`Hoje ${hoje}: buscando ${lote.length} datas (já usadas no mês: ${usadasNoMes}).`);

function resumoVoo(op) {
  const voos = op.flights || [];
  const numeros = voos.map((f) => (f.flight_number || '').replace(/\s+/g, '')).filter(Boolean);
  const cias = [...new Set(voos.map((f) => f.airline).filter(Boolean))];
  const escalas = (op.layovers || []).map((l) => l.id).filter(Boolean);
  const h = Math.floor((op.total_duration || 0) / 60), m = (op.total_duration || 0) % 60;
  return {
    companhia: cias.join(' + '),
    voos_ida: numeros.join(' + '),
    obs: `${escalas.length === 0 ? 'Sem escalas' : escalas.length + (escalas.length === 1 ? ' parada' : ' paradas') + ' em ' + escalas.join(', ')}${op.total_duration ? `, ${h}h ${pad(m)}min` : ''}`,
    saida: voos[0]?.departure_airport?.time?.slice(11) || '',
    chegada: voos[voos.length - 1]?.arrival_airport?.time?.slice(11) || ''
  };
}

const novas = [];
for (const ida of lote) {
  const volta = addDias(ida, DIAS_VIAGEM);
  const url = new URL('https://serpapi.com/search.json');
  Object.entries({
    engine: 'google_flights', departure_id: ORIGEM, arrival_id: DESTINO,
    outbound_date: ida, return_date: volta, type: '1', adults: '1', travel_class: '1',
    currency: 'BRL', hl: 'pt', gl: 'br', api_key: key
  }).forEach(([k, v]) => url.searchParams.set(k, v));

  const base = { checked_at: hoje, ida, volta, preco: null, status: 'erro', companhia: '', voos_ida: '', obs: '', saida: '', chegada: '', link: linkGoogle(ida, volta), fonte: 'serpapi', contou: false };
  try {
    const resp = await fetch(url);
    const j = await resp.json();
    const ops = [...(j.best_flights || []), ...(j.other_flights || [])].filter((o) => typeof o.price === 'number');
    if (ops.length) {
      ops.sort((a, b) => a.price - b.price);
      novas.push({ ...base, ...resumoVoo(ops[0]), preco: ops[0].price, status: 'disponivel', contou: true,
        faixa_tipica: j.price_insights?.typical_price_range || null });
    } else {
      const msg = String(j.error || 'Sem resultados');
      // O SerpApi não cobra buscas sem resultado; datas muito distantes ainda não estão à venda
      novas.push({ ...base, status: /result/i.test(msg) ? 'nao_liberado' : 'erro', obs: msg.slice(0, 120) });
    }
  } catch (e) {
    novas.push({ ...base, obs: 'Falha de rede: ' + String(e.message || e).slice(0, 100) });
  }
  console.log(`${ida} → ${volta}: ${novas[novas.length - 1].preco ?? novas[novas.length - 1].status}`);
}

// Menor preço "atual" antes e depois (última leitura conhecida de cada data)
function atual(rows) {
  const m = new Map();
  for (const r of rows) { const a = m.get(r.ida); if (!a || r.checked_at >= a.checked_at) m.set(r.ida, r); }
  return [...m.values()];
}
const minDe = (rows) => { const v = rows.filter((r) => r.preco != null).map((r) => r.preco); return v.length ? Math.min(...v) : null; };
const antes = minDe(atual(hist));

hist = hist.filter((r) => !(r.checked_at === hoje && novas.some((n) => n.ida === r.ida)));
hist.push(...novas);
hist.sort((a, b) => a.checked_at.localeCompare(b.checked_at) || a.ida.localeCompare(b.ida));
await writeFile(ARQ, JSON.stringify(hist, null, 1) + '\n', 'utf8');

const depois = minDe(atual(hist));
const fmt = (v) => 'R$ ' + v.toLocaleString('pt-BR');
const baratas = novas.filter((r) => r.preco != null && r.preco < REFERENCIA).sort((a, b) => a.preco - b.preco);
let alerta = '';
if (depois != null && antes != null && depois < antes) {
  const r = atual(hist).filter((x) => x.preco === depois)[0];
  alerta = `Passagem Punta Arenas caiu para ${fmt(depois)} (ida ${r.ida.split('-').reverse().join('/')}, volta ${r.volta.split('-').reverse().join('/')}). Antes: ${fmt(antes)}.`;
} else if (baratas.length) {
  const r = baratas[0];
  alerta = `Passagem Punta Arenas abaixo de ${fmt(REFERENCIA)}: ${fmt(r.preco)} (ida ${r.ida.split('-').reverse().join('/')}).`;
}
await writeFile(ALERTA, alerta, 'utf8');
console.log(alerta || 'Nenhuma queda de preço hoje.');

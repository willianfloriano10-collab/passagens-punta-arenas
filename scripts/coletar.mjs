// Coletor diário de preços FLN ⇄ PUQ (outubro/2027) usando a API gratuita do SerpApi (Google Flights).
// Roda no GitHub Actions (Node 20+). Segredos: SERPAPI_KEY e, opcional, WHATSAPP_DESTINOS.
import { readFile, writeFile } from 'node:fs/promises';

const ARQ = new URL('../data/historico.json', import.meta.url);
const ARQ_SITES = new URL('../data/sites.json', import.meta.url);

const ORIGEM = 'FLN';
const DESTINO = 'PUQ';
const DIAS_VIAGEM = 7;             // volta 7 dias depois da ida
const JANELA_VENDA = 330;          // as companhias vendem até ~330 dias antes da volta
const FIM_MONITOR = '2026-12-31';  // depois desse dia o robô não faz mais nada
const REFERENCIA = 2471;
const MAX_POR_DIA = 30;            // teto de buscas de datas por execução
// Tempo de viagem parecido com os voos de referência (ida LA743+LA81: 13h52, volta LA82+LA742: 8h27, 1 parada)
const MAX_PARADAS = 1;
const MAX_MIN_IDA = 16 * 60;
const MAX_MIN_VOLTA = 12 * 60;
const tempoOk = (o, maxMin) => (o.layovers || []).length <= MAX_PARADAS && (!o.total_duration || o.total_duration <= maxMin);
const SITE_URL = process.env.SITE_URL || '';
// Viagens com datas fixas que o usuário quer acompanhar todo dia (além do rodízio de 7 dias)
const VIAGENS_FIXAS = [{ ida: '2027-10-09', volta: '2027-10-17', nome: 'Sua viagem' }];
// Parcelamento: LATAM costuma dar 4x sem juros; em promoções, 10x sem juros
const PARCELAS_PADRAO = 4;
const PARCELAS_PROMO = 10;
// Promoções: feeds gratuitos e palavras que interessam
const FEEDS = ['https://passageirodeprimeira.com/feed/', 'https://www.melhoresdestinos.com.br/feed'];
const RE_VIAGEM = /latam|chile|santiago|punta arenas|patag[oô]nia|10x sem juros|12x sem juros/i;
const RE_BANCOS = /picpay|mercado ?pago|sicoob|coopera|nubank|ultravioleta|santander|esfera/i;
const RE_VIAGEM_GERAL = /passage|milha|pontos|cashback|b[oô]nus|latam|viage|transfer|a[eé]re/i;

const key = process.env.SERPAPI_KEY;
if (!key) { console.error('Falta o segredo SERPAPI_KEY.'); process.exit(1); }

const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
if (hoje > FIM_MONITOR) { console.log(`Monitor encerrado em ${FIM_MONITOR}.`); process.exit(0); }

const pad = (n) => String(n).padStart(2, '0');
const addDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const difDias = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const dm = (s) => s.slice(8, 10) + '/' + s.slice(5, 7);
const fmt = (v) => 'R$ ' + Math.round(v).toLocaleString('pt-BR');
const linkGoogle = (ida, volta) => `https://www.google.com/travel/flights?q=Flights%20to%20${DESTINO}%20from%20${ORIGEM}%20on%20${ida}%20through%20${volta}&hl=pt-BR&curr=BRL`;
const segundaQuinzena = (ida) => Number(ida.slice(8, 10)) >= 16;

async function lerJson(url, padrao) {
  try { return JSON.parse((await readFile(url, 'utf8')).replace(/^\uFEFF/, '')); } catch { return padrao; }
}
async function serp(params) {
  const url = new URL('https://serpapi.com/search.json');
  Object.entries({ engine: 'google_flights', currency: 'BRL', hl: 'pt', gl: 'br', api_key: key, ...params })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  return r.json();
}

const ARQ_FIXAS = new URL('../data/fixas.json', import.meta.url);
const ARQ_PROMOS = new URL('../data/promos.json', import.meta.url);
let hist = await lerJson(ARQ, []);
let sites = await lerJson(ARQ_SITES, []);
let fixas = await lerJson(ARQ_FIXAS, []);
let promos = await lerJson(ARQ_PROMOS, []);

// Quantas parcelas mensais cabem entre o mês seguinte à compra e o mês-alvo (inclusive)
function mesesAte(alvoIso) {
  const [ah, mh] = hoje.split('-').map(Number);
  const [aa, ma] = alvoIso.split('-').map(Number);
  return Math.max(1, (aa - ah) * 12 + (ma - mh));
}
function parcelamento(preco, ida) {
  const umMesAntes = addDias(ida, -30);
  const nAntes = mesesAte(umMesAntes), nViagem = mesesAte(ida);
  return {
    avista: preco,
    padrao: { n: PARCELAS_PADRAO, valor: Math.ceil(preco / PARCELAS_PADRAO) },
    promo: { n: PARCELAS_PROMO, valor: Math.ceil(preco / PARCELAS_PROMO) },
    ate_1_mes_antes: { n: nAntes, valor: Math.ceil(preco / nAntes) },
    ate_viagem: { n: nViagem, valor: Math.ceil(preco / nViagem) }
  };
}

// ---------- 1. Orçamento: quantas buscas ainda restam no mês (consulta grátis) ----------
let restantesMes = 0;
try {
  const conta = await (await fetch('https://serpapi.com/account.json?api_key=' + encodeURIComponent(key))).json();
  restantesMes = Number(conta.plan_searches_left ?? conta.total_searches_left ?? 0);
} catch { restantesMes = 0; }
const [ano, mes] = hoje.split('-').map(Number);
const ultimoDiaMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
const diasRestantes = ultimoDiaMes - Number(hoje.slice(8, 10)) + 1;
const forcar = process.env.TODAS_AS_DATAS === 'true';
let orcamento = Math.max(0, Math.floor((restantesMes - 5) / diasRestantes)); // guarda 5 de folga
if (forcar) orcamento = Math.max(0, restantesMes - 5);
console.log(`Hoje ${hoje}: ${restantesMes} buscas restantes no mês, orçamento de hoje: ${orcamento}.`);

// ---------- 2. Escolher as datas (prioridade para a 2ª quinzena) ----------
const ultimaLeitura = new Map();
for (const r of hist) { const a = ultimaLeitura.get(r.ida); if (!a || r.checked_at >= a.checked_at) ultimaLeitura.set(r.ida, r); }

const candidatas = [];
for (let d = 1; d <= 31; d++) {
  const ida = `2027-10-${pad(d)}`;
  const volta = addDias(ida, DIAS_VIAGEM);
  if (difDias(hoje, volta) > JANELA_VENDA) continue;           // ainda não está à venda: não gasta busca
  const ult = ultimaLeitura.get(ida);
  const idade = ult && ult.preco != null ? difDias(ult.checked_at, hoje) : 99;
  if (ult && ult.checked_at === hoje && ult.preco != null && !forcar) continue;
  const peso = segundaQuinzena(ida) ? 3 : 1;
  candidatas.push({ ida, volta, nota: (idade + 1) * peso });
}
candidatas.sort((a, b) => b.nota - a.nota || a.ida.localeCompare(b.ida));
const reservaSites = orcamento >= 4 ? 2 : 0;                    // 2 buscas para o ranking de sites
const fixasHoje = VIAGENS_FIXAS.filter((v) => difDias(hoje, v.volta) <= JANELA_VENDA && !fixas.some((f) => f.checked_at === hoje && f.ida === v.ida && f.volta === v.volta && f.preco != null));
const reservaFixas = orcamento >= 1 ? fixasHoje.length : 0;
const lote = forcar ? candidatas : candidatas.slice(0, Math.min(MAX_POR_DIA, Math.max(0, orcamento - reservaSites - reservaFixas)));
console.log(`Buscando ${lote.length} datas: ${lote.map((c) => dm(c.ida)).join(', ') || 'nenhuma'}.`);

// ---------- 3. Buscar preços ----------
function resumoVoo(op) {
  const voos = op.flights || [];
  const escalas = (op.layovers || []).map((l) => l.id).filter(Boolean);
  const h = Math.floor((op.total_duration || 0) / 60), m = (op.total_duration || 0) % 60;
  return {
    companhia: [...new Set(voos.map((f) => f.airline).filter(Boolean))].join(' + '),
    voos: voos.map((f) => (f.flight_number || '').replace(/\s+/g, '')).filter(Boolean).join(' + '),
    obs: `${escalas.length === 0 ? 'Sem escalas' : escalas.length + (escalas.length === 1 ? ' parada' : ' paradas') + ' em ' + escalas.join(', ')}${op.total_duration ? `, ${h}h ${pad(m)}min` : ''}`,
    saida: voos[0]?.departure_airport?.time?.slice(11) || '',
    chegada: voos[voos.length - 1]?.arrival_airport?.time?.slice(11) || ''
  };
}

const novas = [];
const tokens = new Map();
for (const { ida, volta } of lote) {
  const base = { checked_at: hoje, ida, volta, preco: null, status: 'erro', companhia: '', voos_ida: '', obs: '', saida: '', chegada: '', link: linkGoogle(ida, volta), fonte: 'serpapi' };
  try {
    const j = await serp({ departure_id: ORIGEM, arrival_id: DESTINO, outbound_date: ida, return_date: volta, type: '1', adults: '1', travel_class: '1', stops: String(MAX_PARADAS + 1), max_duration: String(MAX_MIN_IDA) });
    const ops = [...(j.best_flights || []), ...(j.other_flights || [])].filter((o) => typeof o.price === 'number' && tempoOk(o, MAX_MIN_IDA)).sort((a, b) => a.price - b.price);
    if (ops.length) {
      const r = resumoVoo(ops[0]);
      novas.push({ ...base, companhia: r.companhia, voos_ida: r.voos, obs: r.obs, saida: r.saida, chegada: r.chegada, preco: ops[0].price, status: 'disponivel', faixa_tipica: j.price_insights?.typical_price_range || null });
      if (ops[0].departure_token) tokens.set(ida, ops[0].departure_token);
    } else {
      const msg = String(j.error || 'Sem resultados');
      novas.push({ ...base, status: /result/i.test(msg) ? 'nao_liberado' : 'erro', obs: msg.slice(0, 120) });
    }
  } catch (e) {
    novas.push({ ...base, obs: 'Falha de rede: ' + String(e.message || e).slice(0, 100) });
  }
  const u = novas[novas.length - 1];
  console.log(`${ida} → ${volta}: ${u.preco ?? u.status}`);
}

// Viagens de datas fixas (ex.: 09/10 → 17/10)
const fixaAntes = new Map();
for (const v of VIAGENS_FIXAS) {
  const ant = fixas.filter((f) => f.ida === v.ida && f.volta === v.volta && f.preco != null && f.checked_at < hoje).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
  fixaAntes.set(v.ida + v.volta, ant ? ant.preco : null);
}
for (const v of (reservaFixas || forcar ? fixasHoje : [])) {
  const linha = { checked_at: hoje, ida: v.ida, volta: v.volta, nome: v.nome, preco: null, companhia: '', voos_ida: '', obs: '', link: linkGoogle(v.ida, v.volta) };
  try {
    const j = await serp({ departure_id: ORIGEM, arrival_id: DESTINO, outbound_date: v.ida, return_date: v.volta, type: '1', adults: '1', travel_class: '1', stops: String(MAX_PARADAS + 1), max_duration: String(MAX_MIN_IDA) });
    const ops = [...(j.best_flights || []), ...(j.other_flights || [])].filter((o) => typeof o.price === 'number' && tempoOk(o, MAX_MIN_IDA)).sort((a, b) => a.price - b.price);
    if (ops.length) { const r = resumoVoo(ops[0]); Object.assign(linha, { preco: ops[0].price, companhia: r.companhia, voos_ida: r.voos, obs: r.obs }); }
    else linha.obs = String(j.error || 'Sem resultados').slice(0, 120);
  } catch (e) { linha.obs = 'Falha de rede'; }
  fixas = fixas.filter((f) => !(f.checked_at === hoje && f.ida === v.ida && f.volta === v.volta));
  fixas.push(linha);
  console.log(`Fixa ${v.ida} → ${v.volta}: ${linha.preco ?? linha.obs}`);
}
fixas = fixas.slice(-200);

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

// ---------- 4. Ranking de sites para a data mais barata (2 buscas) ----------
const agora = atual(hist).filter((r) => r.preco != null).sort((a, b) => a.preco - b.preco || (segundaQuinzena(b.ida) - segundaQuinzena(a.ida)) || a.ida.localeCompare(b.ida));
const melhor = agora[0];
let rankingSites = null;
if (melhor && reservaSites && tokens.has(melhor.ida)) {
  try {
    const volta = await serp({ departure_id: ORIGEM, arrival_id: DESTINO, outbound_date: melhor.ida, return_date: melhor.volta, type: '1', departure_token: tokens.get(melhor.ida) });
    const todasVoltas = [...(volta.best_flights || []), ...(volta.other_flights || [])].filter((o) => o.booking_token).sort((a, b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    const voltasOk = todasVoltas.filter((o) => tempoOk(o, MAX_MIN_VOLTA));
    const voltas = voltasOk.length ? voltasOk : todasVoltas;
    if (voltas.length) {
      const rv = resumoVoo(voltas[0]);
      const idx = hist.findIndex((r) => r.checked_at === melhor.checked_at && r.ida === melhor.ida);
      if (idx >= 0) Object.assign(hist[idx], { voos_volta: rv.voos, volta_saida: rv.saida, volta_chegada: rv.chegada });
      const b = await serp({ departure_id: ORIGEM, arrival_id: DESTINO, outbound_date: melhor.ida, return_date: melhor.volta, type: '1', booking_token: voltas[0].booking_token });
      const opcoes = [];
      for (const o of b.booking_options || []) {
        if (o.together && typeof o.together.price === 'number') opcoes.push({ site: o.together.book_with || '?', preco: o.together.price, separado: false });
        else if (o.departing && o.returning && typeof o.departing.price === 'number' && typeof o.returning.price === 'number')
          opcoes.push({ site: `${o.departing.book_with} + ${o.returning.book_with}`, preco: o.departing.price + o.returning.price, separado: true });
      }
      opcoes.sort((a, c) => a.preco - c.preco);
      if (opcoes.length) {
        rankingSites = { checked_at: hoje, ida: melhor.ida, volta: melhor.volta, voos_ida: melhor.voos_ida, voos_volta: rv.voos, opcoes };
        sites = sites.filter((s) => s.checked_at !== hoje);
        sites.push(rankingSites);
        sites = sites.slice(-60);
      }
    }
  } catch (e) { console.log('Ranking de sites falhou: ' + String(e.message || e)); }
}

await writeFile(ARQ, JSON.stringify(hist, null, 1) + '\n', 'utf8');
await writeFile(ARQ_SITES, JSON.stringify(sites, null, 1) + '\n', 'utf8');
await writeFile(ARQ_FIXAS, JSON.stringify(fixas, null, 1) + '\n', 'utf8');

// ---------- 4b. Promoções (feeds gratuitos, não gastam busca do SerpApi) ----------
const decodificar = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const vistos = new Set(promos.map((p) => p.link));
const novasPromos = [];
for (const feed of FEEDS) {
  try {
    const xml = await (await fetch(feed, { headers: { 'User-Agent': 'monitor-passagens/1.0' } })).text();
    for (const bloco of xml.split('<item>').slice(1)) {
      const titulo = decodificar((bloco.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
      const link = decodificar((bloco.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
      const data = new Date(decodificar((bloco.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || ''));
      if (!titulo || !link.startsWith('https://') || vistos.has(link)) continue;
      if (isNaN(data) || Date.now() - data.getTime() > 3 * 86400000) continue;
      const viagem = RE_VIAGEM.test(titulo);
      const banco = RE_BANCOS.test(titulo) && RE_VIAGEM_GERAL.test(titulo);
      if (!viagem && !banco) continue;
      const tipo = banco ? 'cartão' : 'passagem';
      novasPromos.push({ visto_em: hoje, publicado: data.toISOString().slice(0, 10), titulo, link, tipo, fonte: new URL(feed).hostname.replace('www.', '') });
      vistos.add(link);
    }
  } catch (e) { console.log('Feed falhou: ' + feed); }
}
promos = [...promos, ...novasPromos].slice(-60);
await writeFile(ARQ_PROMOS, JSON.stringify(promos, null, 1) + '\n', 'utf8');
console.log(`Promoções novas: ${novasPromos.length}`);

// ---------- 5. Resumo diário no WhatsApp ----------
const depois = minDe(atual(hist));
const ultSites = rankingSites || sites[sites.length - 1] || null;
const linhas = [];
linhas.push(`✈️ *Floripa → Punta Arenas* (ida e volta, 7 dias)`);
linhas.push(`Resumo de ${dm(hoje)}/${hoje.slice(0, 4)}`);
if (depois == null) linhas.push('Ainda não há datas à venda.');
else {
  let var_ = '';
  if (antes != null && depois < antes) var_ = ` 🔻 caiu ${fmt(antes - depois)}`;
  else if (antes != null && depois > antes) var_ = ` 🔺 subiu ${fmt(depois - antes)}`;
  else if (antes != null) var_ = ' (sem mudança)';
  linhas.push(`Menor preço: *${fmt(depois)}*${var_}`);
  for (const v of VIAGENS_FIXAS) {
    const f = fixas.filter((x) => x.ida === v.ida && x.volta === v.volta && x.preco != null).sort((a, b) => b.checked_at.localeCompare(a.checked_at))[0];
    if (!f) continue;
    const ant = fixaAntes.get(v.ida + v.volta);
    const dv = ant == null || f.checked_at !== hoje ? '' : f.preco < ant ? ` 🔻 caiu ${fmt(ant - f.preco)}` : f.preco > ant ? ` 🔺 subiu ${fmt(f.preco - ant)}` : ' (sem mudança)';
    linhas.push(`📌 ${v.nome} ${dm(v.ida)} → ${dm(v.volta)}: *${fmt(f.preco)}*${dv}`);
  }
  const pg = parcelamento(depois, agora[0].ida);
  linhas.push('');
  linhas.push('💳 *Pagamento* (menor preço)');
  linhas.push(`À vista: ${fmt(pg.avista)}`);
  linhas.push(`${pg.padrao.n}x sem juros (padrão LATAM): ${pg.padrao.n}x ${fmt(pg.padrao.valor)}`);
  linhas.push(`${pg.promo.n}x sem juros (só em promoção): ${pg.promo.n}x ${fmt(pg.promo.valor)}`);
  linhas.push(`Quitando 1 mês antes da viagem: até ${pg.ate_1_mes_antes.n}x ${fmt(pg.ate_1_mes_antes.valor)}`);
  linhas.push(`Quitando até a viagem: até ${pg.ate_viagem.n}x ${fmt(pg.ate_viagem.valor)}`);
  linhas.push('');
  linhas.push('🏆 *Ranking de datas*');
  agora.slice(0, 5).forEach((r, i) => linhas.push(`${i + 1}. ida ${dm(r.ida)} → volta ${dm(r.volta)}: ${fmt(r.preco)}${segundaQuinzena(r.ida) ? ' ⭐' : ''}`));
  const q2 = agora.filter((r) => segundaQuinzena(r.ida));
  if (!q2.length) linhas.push('⭐ 2ª quinzena: ainda não está à venda.');
  else if (!agora.slice(0, 5).some((r) => segundaQuinzena(r.ida))) linhas.push(`⭐ Melhor da 2ª quinzena: ida ${dm(q2[0].ida)} por ${fmt(q2[0].preco)}`);
  if (ultSites && ultSites.opcoes?.length) {
    linhas.push('');
    linhas.push(`🛒 *Onde comprar* (ida ${dm(ultSites.ida)})`);
    ultSites.opcoes.slice(0, 5).forEach((o, i) => linhas.push(`${i + 1}. ${o.site}: ${fmt(o.preco)}`));
  }
}
if (novasPromos.length) {
  linhas.push('');
  linhas.push('🎁 *Promoções novas* (LATAM, Chile e seus cartões)');
  novasPromos.slice(0, 5).forEach((p) => linhas.push(`• ${p.titulo}\n${p.link}`));
}
if (SITE_URL) { linhas.push(''); linhas.push(SITE_URL); }
const mensagem = linhas.join('\n');
console.log('\n' + mensagem);

// Aceita: "+5548999999999:1234567", "+5548999999999 1234567", ou o link do CallMeBot (phone=...&apikey=...)
function lerDestino(s) {
  const ph = s.match(/phone=([^&\s]+)/i), ak = s.match(/apikey=([^&\s]+)/i);
  if (ph && ak) return { phone: decodeURIComponent(ph[1]).replace(/[^\d+]/g, ''), apikey: decodeURIComponent(ak[1]).trim() };
  const m = s.match(/(\+?\d[\d\s().-]{9,20}\d)\s*[:=|\s]\s*([A-Za-z0-9]{4,})\s*$/);
  if (m) return { phone: m[1].replace(/[^\d+]/g, ''), apikey: m[2] };
  return null;
}
const brutos = String(process.env.WHATSAPP_DESTINOS || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
const destinos = [];
brutos.forEach((s, i) => {
  const d = lerDestino(s);
  if (!d) { console.log(`WhatsApp: o destino nº ${i + 1} não está no formato +55DDDNUMERO:CHAVE e foi ignorado.`); return; }
  if (!d.phone.startsWith('+')) d.phone = '+' + (d.phone.startsWith('55') ? d.phone : '55' + d.phone);
  destinos.push(d);
});
for (const { phone, apikey } of destinos) {
  try {
    const u = 'https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(phone) + '&text=' + encodeURIComponent(mensagem) + '&apikey=' + encodeURIComponent(apikey);
    const r = await fetch(u);
    const corpo = (await r.text()).replace(/<[^>]+>/g, ' ');
    const situacao = /queued|sent|enviad/i.test(corpo) ? 'enviada' : /apikey|invalid|wrong|error|not/i.test(corpo) ? 'recusada (confira número e chave)' : 'resposta desconhecida';
    console.log(`WhatsApp para ...${phone.slice(-4)}: HTTP ${r.status}, ${situacao}`);
  } catch (e) { console.log(`WhatsApp para ...${phone.slice(-4)} falhou: ${e.message}`); }
  await new Promise((res) => setTimeout(res, 3000));
}
if (!destinos.length) console.log('Sem WHATSAPP_DESTINOS: nenhuma mensagem enviada.');

'use strict';

require('dotenv').config();

// Emulator licznika Chint DTSU666 (3P4W) jako serwer Modbus TCP.
// Mapa rejestrów wg oficjalnego manuala ZTW0.464.0104 V1 (10/2023), Table 11.
// Format: IEEE754 float32, 2 słowa, kolejność bajtów ABCD (big-endian, high word first).
// Funkcja: 0x03 (Read Holding Registers).
// UWAGA: pomiary mają mnożniki — wartości w rejestrze trzeba skalować
//        zgodnie z kolumną "Instructions of parameters" z manuala.

const ModbusRTU = require('modbus-serial');
const ServerTCP = ModbusRTU.ServerTCP;
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CONFIG = {
  fnfUrl: process.env.FNF_URL || 'http://192.168.100.35',
  // F&F akceptuje max 1 request / 4 s. Każdy tick wysyła JEDNO żądanie.
  tickMs:           Number(process.env.TICK_MS    || 4000),
  energyPeriodMs:   Number(process.env.ENERGY_MS  || 60000), // odświeżanie energii (zmienia się wolno)
  httpTimeoutMs:    3500,
  tcpHost: process.env.TCP_HOST || '0.0.0.0',
  tcpPort: Number(process.env.TCP_PORT || 502),
  slaveId: Number(process.env.SLAVE_ID || 1),
};

// Mapa adres -> uint16
const registers = new Map();

const setFloat = (addr, value) => {
  const v = Number.isFinite(value) ? value : 0;
  const buf = Buffer.alloc(4);
  buf.writeFloatBE(v, 0);                      // ABCD: A=byte0 (MSB), D=byte3 (LSB)
  registers.set(addr,     buf.readUInt16BE(0)); // high word (AB)
  registers.set(addr + 1, buf.readUInt16BE(2)); // low  word (CD)
};

const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const avg = (arr) => sum(arr) / arr.length;

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, CONFIG.fnfUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.setTimeout(CONFIG.httpTimeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchPower() {
  const p = await fetchJson('/0000/get_current_parameters');
  if (!p || p.status !== 'ok') throw new Error('bad power response');

  const SQ3 = Math.sqrt(3);

  // === Napięcia międzyfazowe (Uab/Ubc/Uca), Unit V ×0.1V → zapis: V × 10 ===
  // F&F nie podaje napięć L-L; szacujemy jako √3 × U_faza (poprawne tylko dla układu zbalansowanego).
  setFloat(0x2000, p.voltage[0] * SQ3 * 10); // Uab
  setFloat(0x2002, p.voltage[1] * SQ3 * 10); // Ubc
  setFloat(0x2004, p.voltage[2] * SQ3 * 10); // Uca

  // === Napięcia fazowe (Ua/Ub/Uc), Unit V ×0.1V ===
  setFloat(0x2006, p.voltage[0] * 10); // Ua
  setFloat(0x2008, p.voltage[1] * 10); // Ub
  setFloat(0x200A, p.voltage[2] * 10); // Uc

  // === Prądy (Ia/Ib/Ic), Unit A ×0.001A → zapis: A × 1000 ===
  setFloat(0x200C, p.current[0] * 1000); // Ia
  setFloat(0x200E, p.current[1] * 1000); // Ib
  setFloat(0x2010, p.current[2] * 1000); // Ic

  // === Moc czynna (Pt/Pa/Pb/Pc), Unit W ×0.1W → zapis: W × 10 ===
  setFloat(0x2012, sum(p.power_active) * 10); // Pt
  setFloat(52,     sum(p.power_active));      // Pt (mapa "classic"/SDM630, W, float)
  setFloat(0x2014, p.power_active[0]   * 10); // Pa
  setFloat(0x2016, p.power_active[1]   * 10); // Pb
  setFloat(0x2018, p.power_active[2]   * 10); // Pc

  // === Moc bierna (Qt/Qa/Qb/Qc), Unit var ×0.1var → zapis: var × 10 ===
  setFloat(0x201A, sum(p.power_reactive) * 10); // Qt
  setFloat(0x201C, p.power_reactive[0]   * 10); // Qa
  setFloat(0x201E, p.power_reactive[1]   * 10); // Qb
  setFloat(0x2020, p.power_reactive[2]   * 10); // Qc

  // 0x2022..0x2028 = RESERVED w manualu — nie używać.

  // === Power Factor (PFt/PFa/PFb/PFc), ×0.001 → zapis: PF × 1000 ===
  // Konwencja Chint: dodatni = indukcyjny, ujemny = pojemnościowy.
  // F&F Energy 3 stosuje tę samą konwencję znaku.
  setFloat(0x202A, avg(p.power_factor) * 1000); // PFt
  setFloat(0x202C, p.power_factor[0]   * 1000); // PFa
  setFloat(0x202E, p.power_factor[1]   * 1000); // PFb
  setFloat(0x2030, p.power_factor[2]   * 1000); // PFc

  // === Częstotliwość, Unit Hz ×0.01Hz → zapis: Hz × 100 ===
  setFloat(0x2044, avg(p.frequency) * 100);

  return `Pt=${sum(p.power_active).toFixed(1)}W Qt=${sum(p.power_reactive).toFixed(1)}var f=${avg(p.frequency).toFixed(2)}Hz`;
}

async function fetchEnergy() {
  const e = await fetchJson('/0000/get_total_energy');
  if (!e || e.status !== 'ok') throw new Error('bad energy response');

  // Energia czynna w kWh, format float bez skalowania (manual: "kWh", float, 2 word).
  // F&F zwraca Wh → dzielimy przez 1000.
  const WH_TO_KWH = 1 / 1000;
  const impA = e.active_energy_import[0] * WH_TO_KWH;
  const impB = e.active_energy_import[1] * WH_TO_KWH;
  const impC = e.active_energy_import[2] * WH_TO_KWH;
  const expA = e.active_energy_export[0] * WH_TO_KWH;
  const expB = e.active_energy_export[1] * WH_TO_KWH;
  const expC = e.active_energy_export[2] * WH_TO_KWH;

  const impTot = impA + impB + impC;
  const expTot = expA + expB + expC;
  const net    = impTot - expTot;

  // Forward (Imp) — energia pobrana z sieci
  setFloat(0x101E, impTot);              // ImpEp   total
  setFloat(0x1020, impA);                // ImpEpA
  setFloat(0x1022, impB);                // ImpEpB
  setFloat(0x1024, impC);                // ImpEpC
  setFloat(0x1026, Math.max(0,  net));   // NetImpEp

  // Reverse (Exp) — energia oddana do sieci
  setFloat(0x1028, expTot);              // ExpEp   total
  setFloat(0x102A, expA);                // ExpEpA
  setFloat(0x102C, expB);                // ExpEpB
  setFloat(0x102E, expC);                // ExpEpC
  setFloat(0x1030, Math.max(0, -net));   // NetExpEp

  // Energia bierna nie jest udokumentowana w tym wydaniu manuala
  // (Note 2: "call for the detailed communication protocol") — pomijamy.

  return `Imp=${impTot.toFixed(3)}kWh Exp=${expTot.toFixed(3)}kWh`;
}

// Scheduler: tylko JEDEN request co `tickMs` (limit F&F = 1/4s).
// Energia odświeżana co `energyPeriodMs`, w pozostałych tickach pobierane są pomiary chwilowe.
let lastEnergyAt = 0;
let busy = false;

async function tick() {
  if (busy) return; // jeśli poprzedni request jeszcze trwa, pomiń ten tick (nie nakładamy żądań)
  busy = true;
  const now = Date.now();
  const wantEnergy = (now - lastEnergyAt) >= CONFIG.energyPeriodMs;
  const kind = wantEnergy ? 'energy' : 'power';
  try {
    const info = wantEnergy ? await fetchEnergy() : await fetchPower();
    process.stdout.write(`[${new Date().toISOString()}] OK ${kind.padEnd(6)} ${info}\n`);
  } catch (err) {
    process.stderr.write(`[${new Date().toISOString()}] ERR ${kind.padEnd(6)} ${err.message}\n`);
  } finally {
    // Bumpuj lastEnergyAt nawet po błędzie, żeby pojedyncza awaria endpointu energii
    // nie blokowała odczytów pomiarów chwilowych w kolejnych tickach.
    if (wantEnergy) lastEnergyAt = Date.now();
    busy = false;
  }
}

const vector = {
  // DTSU666 obsługuje tylko 0x03 (Read Holding Registers); 0x04 dodajemy "na zapas".
  getHoldingRegister: (addr, _unitID, cb) => cb(null, registers.get(addr) || 0),
  getInputRegister:   (addr, _unitID, cb) => cb(null, registers.get(addr) || 0),
};

const server = new ServerTCP(vector, {
  host: CONFIG.tcpHost,
  port: CONFIG.tcpPort,
  debug: false,
  unitID: CONFIG.slaveId,
});

server.on('socketError', (err) => process.stderr.write(`socket error: ${err.message}\n`));
server.on('serverError', (err) => process.stderr.write(`server error: ${err.message}\n`));

process.stdout.write(`DTSU666 emulator -> Modbus TCP ${CONFIG.tcpHost}:${CONFIG.tcpPort} (slave ${CONFIG.slaveId})\n`);
process.stdout.write(`Source: ${CONFIG.fnfUrl}  tick=${CONFIG.tickMs}ms  energy refresh=${CONFIG.energyPeriodMs}ms\n`);

tick();
setInterval(tick, CONFIG.tickMs);

const shutdown = () => {
  process.stdout.write('shutting down...\n');
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

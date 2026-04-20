# ff-energy3-dtsu666-bridge

Most pomiędzy licznikiem **F&F Energy 3** (REST API po HTTP) a klientem oczekującym licznika **Chint DTSU666** po Modbus TCP. Cyklicznie pobiera dane z F&F i wystawia je w mapie rejestrów zgodnej z oficjalnym manualem DTSU666 (ZTW0.464.0104 V1, 10/2023).

Zastosowanie: udawanie licznika DTSU666 dla falownika **FoxESS T8 G3** (export limiting / pomiar oddania do sieci), gdy w instalacji jest już licznik **F&F Energy 3** z dostępem przez sieć. FoxESS T-G3 obsługuje DTSU666 jako external meter na porcie RS485 (Meter port).

## Architektura

```
┌─────────────────┐  HTTP/JSON   ┌──────────────────┐  Modbus TCP  ┌──────────────┐  Modbus RTU   ┌──────────────┐
│  F&F Energy 3   │ ───────────> │  ten bridge      │ ───────────> │  USR-DR164   │ ──RS485─────> │  FoxESS T8   │
│  (RS485 + LAN)  │   port 80    │  (Node.js, TCP)  │  port 502    │  TCP↔RTU GW  │   9600 8N1    │  G3 (Meter)  │
└─────────────────┘              └──────────────────┘              └──────────────┘               └──────────────┘
```

Konwersja Modbus TCP → RTU realizowana przez bramkę **USR-DR164** w trybie *Modbus TCP to RTU gateway*. Bridge jest dla niej zwykłym serwerem Modbus TCP slave (port 502, slave ID 1 - zgodnie z domyślną konfiguracją DTSU666 oczekiwaną przez FoxESS).

## Wymagania

- Node.js (testowane na 16, działa też na nowszych)
- Sieciowy dostęp do F&F Energy 3 po HTTP
- Klient Modbus **TCP** (nie RTU - patrz "Ograniczenia")

## Instalacja

```bash
git clone <repo>
cd ff-energy3-dtsu666-bridge
npm install
cp .env.example .env
# edytuj .env - ustaw co najmniej FNF_URL
```

## Uruchomienie

```bash
sudo node server.js          # port 502 wymaga uprawnień roota
# lub:
TCP_PORT=5020 node server.js # bez roota na nieprzywilejowanym porcie
# lub:
npm start
```

Zatrzymanie: `Ctrl+C`.

## Konfiguracja (`.env`)

| Zmienna     | Default                  | Opis                                              |
|-------------|--------------------------|---------------------------------------------------|
| `FNF_URL`   | `http://192.168.100.35`  | adres bazowy F&F Energy 3                         |
| `TCP_HOST`  | `0.0.0.0`                | interfejs nasłuchu Modbus TCP                     |
| `TCP_PORT`  | `502`                    | port Modbus TCP                                   |
| `SLAVE_ID`  | `1`                      | adres Modbus slave                                |
| `TICK_MS`   | `4000`                   | minimalny odstęp między requestami do F&F         |
| `ENERGY_MS` | `60000`                  | jak często odświeżać liczniki energii             |

Zmienne z linii komend nadpisują wartości z `.env`.

## Endpointy F&F używane przez bridge

- `GET /0000/get_current_parameters` - napięcia, prądy, moc czynna/bierna, częstotliwość, PF
- `GET /0000/get_total_energy` - energia czynna import/export per faza (w Wh)

## Scheduling

F&F Energy 3 toleruje maksymalnie **1 request co 4 sekundy**. Bridge wysyła **jedno** żądanie na tick:
- pomiary chwilowe (`current_parameters`) - co tick
- energia (`total_energy`) - co `ENERGY_MS` (domyślnie 60 s) zamiast pomiaru

Daje to świeżość pomiarów ~4 s i świeżość energii ~60 s. Liczniki energii zmieniają się o ułamki kWh - 60 s to bezpieczny kompromis.

Jeśli poprzedni request jeszcze trwa (timeout 3.5 s), kolejny tick jest pomijany - bridge nigdy nie nakłada żądań.

## Mapa rejestrów

Format: **IEEE754 float32, 2 słowa (4 bajty), kolejność ABCD** (big-endian, high word first).
Funkcja Modbus: **0x03** (Read Holding Registers).

### Pomiary chwilowe

| Adres   | Kod   | Opis                          | Mnożnik   | Jednostka |
|---------|-------|-------------------------------|-----------|-----------|
| 0x2000  | Uab   | Napięcie międzyfazowe A-B     | × 0.1     | V         |
| 0x2002  | Ubc   | Napięcie międzyfazowe B-C     | × 0.1     | V         |
| 0x2004  | Uca   | Napięcie międzyfazowe C-A     | × 0.1     | V         |
| 0x2006  | Ua    | Napięcie fazowe A             | × 0.1     | V         |
| 0x2008  | Ub    | Napięcie fazowe B             | × 0.1     | V         |
| 0x200A  | Uc    | Napięcie fazowe C             | × 0.1     | V         |
| 0x200C  | Ia    | Prąd fazy A                   | × 0.001   | A         |
| 0x200E  | Ib    | Prąd fazy B                   | × 0.001   | A         |
| 0x2010  | Ic    | Prąd fazy C                   | × 0.001   | A         |
| 0x2012  | Pt    | Moc czynna sumaryczna         | × 0.1     | W         |
| 0x2014  | Pa    | Moc czynna fazy A             | × 0.1     | W         |
| 0x2016  | Pb    | Moc czynna fazy B             | × 0.1     | W         |
| 0x2018  | Pc    | Moc czynna fazy C             | × 0.1     | W         |
| 0x201A  | Qt    | Moc bierna sumaryczna         | × 0.1     | var       |
| 0x201C  | Qa    | Moc bierna fazy A             | × 0.1     | var       |
| 0x201E  | Qb    | Moc bierna fazy B             | × 0.1     | var       |
| 0x2020  | Qc    | Moc bierna fazy C             | × 0.1     | var       |
| 0x202A  | PFt   | Współczynnik mocy sumaryczny  | × 0.001   | -         |
| 0x202C  | PFa   | Współczynnik mocy fazy A      | × 0.001   | -         |
| 0x202E  | PFb   | Współczynnik mocy fazy B      | × 0.001   | -         |
| 0x2030  | PFc   | Współczynnik mocy fazy C      | × 0.001   | -         |
| 0x2044  | Freq  | Częstotliwość                 | × 0.01    | Hz        |

Konwencja PF: **dodatni = indukcyjny, ujemny = pojemnościowy** (zgodnie z manualem Chint).

### Energia

Format: float32 w **kWh, bez skalowania** (manual: "kWh", float, 2 word).

| Adres   | Kod      | Opis                                     |
|---------|----------|------------------------------------------|
| 0x101E  | ImpEp    | Energia czynna pobrana - sumaryczna      |
| 0x1020  | ImpEpA   | Energia pobrana - faza A                 |
| 0x1022  | ImpEpB   | Energia pobrana - faza B                 |
| 0x1024  | ImpEpC   | Energia pobrana - faza C                 |
| 0x1026  | NetImpEp | Net pobrana = max(0, Imp − Exp)          |
| 0x1028  | ExpEp    | Energia czynna oddana - sumaryczna       |
| 0x102A  | ExpEpA   | Energia oddana - faza A                  |
| 0x102C  | ExpEpB   | Energia oddana - faza B                  |
| 0x102E  | ExpEpC   | Energia oddana - faza C                  |
| 0x1030  | NetExpEp | Net oddana = max(0, Exp − Imp)           |

## Przykład odczytu (Node.js, `modbus-serial`)

```js
const ModbusRTU = require('modbus-serial');
const c = new ModbusRTU();

await c.connectTCP('192.168.1.50', { port: 502 });
c.setID(1);

const r = await c.readHoldingRegisters(0x2012, 2);
const buf = Buffer.from([
  (r.data[0] >> 8) & 0xff, r.data[0] & 0xff,
  (r.data[1] >> 8) & 0xff, r.data[1] & 0xff,
]);
const ptW = buf.readFloatBE(0) * 0.1;  // mnożnik z mapy rejestrów
console.log('Total active power:', ptW.toFixed(1), 'W');
```

## Ograniczenia i uwagi

- **Modbus TCP, nie RTU.** Oryginalny DTSU666 to RS485 9600 8N1. Bridge wystawia Modbus TCP. W tej instalacji konwersję na RS485 robi bramka **USR-DR164** w trybie *Modbus TCP to RTU gateway* (alternatywnie: USR-TCP232, esp-link, gateway w samym falowniku).
- **Tylko odczyt** (funkcja 0x03). Funkcja 0x10 (write) nie jest obsługiwana - rejestry konfiguracyjne (Keyboard parameters 0x0000-0x002E) celowo nie zaimplementowane.
- **Napięcia międzyfazowe (Uab/Ubc/Uca)** są szacowane jako √3 × U_faza. F&F Energy 3 nie podaje napięć L-L. Wartości są poprawne tylko dla układu zbalansowanego.
- **Energia bierna** nie jest dostępna w oficjalnym manualu DTSU666 ZTW0.464.0104 V1 (Note 2 odsyła do "detailed communication protocol"). Dane z F&F nie są mapowane na żadne rejestry.
- **3P4W**. Bridge emuluje wariant trójfazowy czteroprzewodowy. Wariant 3P3W (DSSU666) nie jest celem.

## Licencja

MIT

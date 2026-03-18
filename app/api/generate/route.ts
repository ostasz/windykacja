import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import iconv from 'iconv-lite'

export const runtime = 'nodejs'
export const maxDuration = 60

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type Row = (string | number | Date | boolean | null)[]

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAYS_CUTOFF = 47
const MIN_DEBT = 500
const DAYS_NOTICE = 7

const POLISH_MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paz', 'lis', 'gru']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function readXlsx(buffer: Buffer, sheetMatcher?: (name: string) => boolean): Row[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  const sheetName = sheetMatcher
    ? wb.SheetNames.find(sheetMatcher) ?? wb.SheetNames[0]
    : wb.SheetNames[0]
  const ws = wb.Sheets[sheetName]
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, defval: null, raw: true })
}

function toDate(val: unknown): Date | null {
  if (val instanceof Date) return val
  if (typeof val === 'string') {
    const d = new Date(val)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtAmount(val: unknown): string {
  if (val === null || val === undefined || val === '') return ''
  const n = parseFloat(String(val))
  if (isNaN(n)) return ''
  return n.toFixed(2).replace('.', ',')
}

function toNip(val: unknown): string {
  if (val === null || val === undefined) return ''
  // Remove decimals (.0) that come from numeric Excel cells
  return String(Math.round(Number(val)))
}

function escapeField(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val).replace(/;/g, ',').trim()
}

function looksLikeExcelDate(adres1: string): boolean {
  const lower = adres1.toLowerCase().trim()
  return POLISH_MONTHS.some((m) =>
    /^[a-ząćęłńóśźżA-ZĄĆĘŁŃÓŚŹŻ]+\s\d{1,2}$/.test(adres1.trim()) && lower.startsWith(m)
  )
}

function fixAddress(adres1: string): string {
  return adres1.trim().replace(/^(.+)\s(\d{1,2})$/, '$1 nr $2')
}

// ---------------------------------------------------------------------------
// Build address lookup: NIP → { adres1, adres2 }
// ---------------------------------------------------------------------------
function buildAddressLookup(buffer: Buffer): Map<string, { adres1: string; adres2: string }> {
  const rows = readXlsx(buffer, (name) => name.toLowerCase().includes('adres'))
  const map = new Map<string, { adres1: string; adres2: string }>()

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const nipRaw = row[0]
    if (!nipRaw) continue

    const nip = toNip(nipRaw)
    const miejscowosc = String(row[12] ?? '').trim()  // col M
    const kod = String(row[13] ?? '').trim()           // col N
    const ulica = String(row[14] ?? '').trim()         // col O
    const nrDomu = String(row[15] ?? '').trim()        // col P
    const nrLokalu = String(row[16] ?? '').trim()      // col Q

    const rawAdres1 = nrLokalu
      ? `${ulica} ${nrDomu}/${nrLokalu}`.trim()
      : `${ulica} ${nrDomu}`.trim()

    const adres1 = looksLikeExcelDate(rawAdres1) ? fixAddress(rawAdres1) : rawAdres1
    const adres2 = `${kod} ${miejscowosc}`.trim()

    map.set(nip, { adres1, adres2 })
  }

  return map
}

// ---------------------------------------------------------------------------
// Build date lookup from previous KRD CSV: (NIP, docNr) → sendDate
// ---------------------------------------------------------------------------
function buildDateLookup(buffer: Buffer): Map<string, string> {
  const content = iconv.decode(buffer, 'windows-1250')
  const lines = content.split('\n')
  const map = new Map<string, string>()

  for (const line of lines.slice(1)) {
    const fields = line.split(';')
    if (fields.length < 35) continue
    const nip = fields[4].trim()
    const tytul = fields[27].trim()
    const ident = fields[26].trim()
    const rawDate = fields[34].trim()
    const match = rawDate.match(/\d{4}-\d{2}-\d{2}/)
    if (!match || !nip) continue

    const date = match[0]
    if (tytul) map.set(`${nip}|${tytul}`, date)
    const identClean = ident.replace(/\/0+1$/, '').trim()
    if (identClean && identClean !== tytul) map.set(`${nip}|${identClean}`, date)
  }

  return map
}

// ---------------------------------------------------------------------------
// Process dluznicy.xlsx → CSV rows
// ---------------------------------------------------------------------------
function buildCsvRows(
  buffer: Buffer,
  addressMap: Map<string, { adres1: string; adres2: string }>,
  dateMap: Map<string, string>,
  today: Date,
): string[] {
  const cutoff = dateOnly(addDays(today, -DAYS_CUTOFF))
  const rows = readXlsx(buffer)

  const dataRows: string[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    const nazwa = row[0]          // col A
    const nipRaw = row[1]         // col B
    const nrDok = row[2]          // col C
    const przychod = row[3]       // col D — Wysokość zobowiązania
    const kwota = row[4]          // col E — Kwota zadłużenia
    const terminRaw = row[9]      // col J — Termin płatności

    if (!nipRaw || !terminRaw || kwota === null || kwota === undefined) continue
    const termin = toDate(terminRaw)
    if (!termin) continue
    const terminDate = dateOnly(termin)
    if (terminDate > cutoff) continue

    const nip = toNip(nipRaw)
    const terminStr = fmtDate(terminDate)
    const nrDokStr = escapeField(nrDok)
    const nazwaStr = escapeField(nazwa)
    const high = fmtAmount(przychod !== null ? przychod : kwota)
    const low = fmtAmount(kwota)
    const identyfikatorSprawy = `${nip}/1`

    const dateKey = `${nip}|${nrDokStr}`
    const dataSendStr = dateMap.get(dateKey) ?? fmtDate(addDays(terminDate, DAYS_NOTICE))

    const addr = addressMap.get(nip)
    const adres1 = addr?.adres1 ?? ''
    const adres2 = addr?.adres2 ?? ''
    const adres3 = addr ? 'Polska' : ''

    const fields: string[] = [
      'UPD',               // 1
      'LP',                // 2
      identyfikatorSprawy, // 3
      nazwaStr,            // 4
      nip,                 // 5
      '',                  // 6  REGON
      '',                  // 7  EKD
      '',                  // 8  Numer w rejestrze
      '',                  // 9  Sąd rejestrowy
      adres1,              // 10 Adres siedziby1
      adres2,              // 11 Adres siedziby2
      adres3,              // 12 Adres siedziby3
      '',                  // 13 Adres siedziby4
      '',                  // 14 Imię
      '',                  // 15 Drugie imię
      '',                  // 16 Nazwisko
      '',                  // 17 Obywatelstwo
      '',                  // 18 Adres zamieszkania1
      '',                  // 19 Adres zamieszkania2
      '',                  // 20 Adres
      '',                  // 21 Adres
      '',                  // 22 Data urodzenia
      '',                  // 23 PESEL
      '',                  // 24 Typ dokumentu tożsamości
      '',                  // 25 Seria
      '',                  // 26 Numer
      nrDokStr,            // 27 Identyfikator zobowiązania
      nrDokStr,            // 28 Tytuł zobowiązania
      high,                // 29 Wysokość zobowiązania
      low,                 // 30 Kwota zadłużenia
      'PLN',               // 31 Waluta
      terminStr,           // 32 Termin wymagalności
      '',                  // 33 Opis obiekcji
      '',                  // 34 Opis postępowania
      dataSendStr,         // 35 Data wysłania wezwania
      '',                  // 36 Data zakończenia zawieszenia
      '',                  // 37 Powiadomienie dłużnika
      '',                  // 38 Adres wysłania 1
      '',                  // 39 Adres wysłania 2
      '',                  // 40 Adres wysłania 3
      '',                  // 41 Adres wysłania 4
      '',                  // 42 Sygnatura Akt
      '',                  // 43 Data wydania tytułu
      '',                  // 44 Organ orzekający
      '',                  // 45 Numer konta
      '',                  // 46 Adres właściciela 1
      '',                  // 47 Adres właściciela 2
      '',                  // 48 Nazwa właściciela
    ]

    dataRows.push(fields.join(';'))
  }

  return dataRows
}

// ---------------------------------------------------------------------------
// Filter clients below MIN_DEBT threshold
// ---------------------------------------------------------------------------
function filterByMinDebt(rows: string[]): string[] {
  const totals = new Map<string, number>()
  for (const row of rows) {
    const fields = row.split(';')
    const nip = fields[4]
    const kwota = parseFloat((fields[29] ?? '').replace(',', '.'))
    if (!isNaN(kwota)) totals.set(nip, (totals.get(nip) ?? 0) + kwota)
  }
  const below = new Set([...totals.entries()].filter(([, v]) => v < MIN_DEBT).map(([k]) => k))
  return rows.filter((row) => !below.has(row.split(';')[4]))
}

// ---------------------------------------------------------------------------
// CSV header
// ---------------------------------------------------------------------------
const HEADER =
  '#Operacja;Rodzaj dluznika;Identyfikator sprawy;Nazwa firmy;NIP;REGON;EKD;' +
  'Numer w rejestrze;Sad rejestrowy;Adres siedziby1 (ulica i numer);' +
  'Adres siedziby2 (kod pocztowy i miasto);Adres siedziby3;Adres siedziby4;' +
  'Imie;Drugie imie;Nazwisko;Obywatelstwo;Adres zamieszkania1 (ulica i numer);' +
  'Adres zamieszkania2 (kod pocztowy i miasto);Adres;Adres;Data urodzenia;PESEL;' +
  'Typ dokumentu tozsamosci;Seria;Numer;Identyfikator zobowiazania;Tytul zobowiazania;' +
  'Wysokosc zobowiazania;Kwota zadluzenia;Waluta;Termin wymagalnosci;' +
  'Opis obiekcji dluznika;Opis dotychczasowego postepowania;Data wyslania wezwania;' +
  'Data zakonczenia zawieszenia;Powiadomienie dluznika;' +
  'Adres wyslania powiadomienia1 (ulica i numer);Adres wyslania powiadomienia2 (kod pocztowy i miasto);' +
  'Adres wyslania 3;Adres wyslania 4;Sygnatura Akt;Data wydania tytulu wykonawczego;' +
  'Organ orzekajacy;Numer konta bankowego;Adres wlasciciela konta bankowego 1;' +
  'Adres wlasciciela konta bankowego 2;Nazwa wlasciciela konta bankowego'

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Błąd odczytu formularza' }, { status: 400 })
  }

  const dluznicyFile = formData.get('dluznicy') as File | null
  const adresyFile = formData.get('adresy') as File | null
  const staryKrdFile = formData.get('staryKrd') as File | null

  if (!dluznicyFile || !adresyFile) {
    return NextResponse.json({ error: 'Brakuje wymaganych plików' }, { status: 400 })
  }

  try {
    const [dluznicyBuf, adresyBuf, staryKrdBuf] = await Promise.all([
      dluznicyFile.arrayBuffer().then(Buffer.from),
      adresyFile.arrayBuffer().then(Buffer.from),
      staryKrdFile ? staryKrdFile.arrayBuffer().then(Buffer.from) : Promise.resolve(null),
    ])

    const addressMap = buildAddressLookup(adresyBuf)
    const dateMap = staryKrdBuf ? buildDateLookup(staryKrdBuf) : new Map<string, string>()

    const today = new Date()
    let dataRows = buildCsvRows(dluznicyBuf, addressMap, dateMap, today)
    dataRows = filterByMinDebt(dataRows)

    const csvContent = [HEADER, ...dataRows].join('\n')
    const encoded = iconv.encode(csvContent, 'windows-1250')

    const dateStr = fmtDate(today).split('-').reverse().join('.')
    const outputFileName = `KRD_dluznicy_${dateStr}.csv`

    return new NextResponse(encoded, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=windows-1250',
        'Content-Disposition': `attachment; filename="${outputFileName}"`,
        'X-Row-Count': String(dataRows.length),
      },
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Błąd przetwarzania'
    console.error('[generate]', e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

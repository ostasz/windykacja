'use client'

import { useState, useRef } from 'react'

type FileState = File | null

function FileZone({
  label,
  hint,
  accept,
  required,
  value,
  onChange,
}: {
  label: string
  hint: string
  accept: string
  required: boolean
  value: FileState
  onChange: (f: FileState) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <div
      className={`border-2 border-dashed rounded-lg p-5 cursor-pointer transition-colors ${
        value
          ? 'border-green-500 bg-green-950/30'
          : 'border-gray-600 hover:border-gray-400 bg-gray-900/50'
      }`}
      onClick={() => ref.current?.click()}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      <div className="flex items-start gap-3">
        <span className="text-2xl">{value ? '✅' : required ? '📂' : '📎'}</span>
        <div>
          <p className="font-semibold text-sm">
            {label}
            {!required && <span className="ml-2 text-xs text-gray-400 font-normal">(opcjonalny)</span>}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{hint}</p>
          {value && (
            <p className="text-xs text-green-400 mt-1 truncate max-w-xs">{value.name}</p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const [dluznicy, setDluznicy] = useState<FileState>(null)
  const [adresy, setAdresy] = useState<FileState>(null)
  const [staryKrd, setStaryKrd] = useState<FileState>(null)
  const [fakturowanie, setFakturowanie] = useState<FileState>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')

  async function handleGenerate() {
    if (!dluznicy || !adresy) {
      setStatus('error')
      setMessage('Wymagane pliki: dluznicy.xlsx i plik adresów.')
      return
    }

    setStatus('loading')
    setMessage('Przetwarzanie plików...')
    setDownloadUrl(null)

    const form = new FormData()
    form.append('dluznicy', dluznicy)
    form.append('adresy', adresy)
    if (staryKrd) form.append('staryKrd', staryKrd)
    if (fakturowanie) form.append('fakturowanie', fakturowanie)

    try {
      const res = await fetch('/api/generate', { method: 'POST', body: form })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error ?? 'Nieznany błąd serwera')
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const cd = res.headers.get('Content-Disposition') ?? ''
      const match = cd.match(/filename="?([^"]+)"?/)
      const name = match?.[1] ?? 'KRD.csv'
      setDownloadUrl(url)
      setFileName(name)
      setStatus('done')
      const count = res.headers.get('X-Row-Count') ?? '?'
      setMessage(`Wygenerowano ${count} wierszy.`)
    } catch (e: unknown) {
      setStatus('error')
      setMessage(e instanceof Error ? e.message : 'Błąd przetwarzania')
    }
  }

  return (
    <main className="max-w-xl mx-auto px-4 py-12">
      <h1 className="text-2xl font-bold mb-1">Generator KRD</h1>
      <p className="text-gray-400 text-sm mb-8">
        Generuje plik CSV do wysłania do KRD na podstawie listy należności.
      </p>

      <div className="flex flex-col gap-3 mb-6">
        <FileZone
          label="Lista należności"
          hint="dluznicy.xlsx — raport należności wymagalnych"
          accept=".xlsx"
          required
          value={dluznicy}
          onChange={setDluznicy}
        />
        <FileZone
          label="Adresy korespondencyjne"
          hint="plik z arkuszem AdresyOdświeżalne (kolumny A, M–Q)"
          accept=".xlsx"
          required
          value={adresy}
          onChange={setAdresy}
        />
        <FileZone
          label="Poprzedni plik KRD"
          hint="Dopisz*.csv — daty wysłania wezwań zostaną przepisane"
          accept=".csv"
          required={false}
          value={staryKrd}
          onChange={setStaryKrd}
        />
        <FileZone
          label="Raport fakturowania (wytwórcy)"
          hint="Fakturowanie*.xlsx — wytwórcy z kolumny NIP (K) zostaną wykluczeni z listy KRD"
          accept=".xlsx"
          required={false}
          value={fakturowanie}
          onChange={setFakturowanie}
        />
      </div>

      <button
        onClick={handleGenerate}
        disabled={status === 'loading'}
        className="w-full py-3 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50
          bg-blue-600 hover:bg-blue-500 disabled:cursor-not-allowed"
      >
        {status === 'loading' ? 'Generowanie…' : 'Generuj plik CSV'}
      </button>

      {status !== 'idle' && (
        <div
          className={`mt-4 rounded-lg px-4 py-3 text-sm ${
            status === 'error'
              ? 'bg-red-950 border border-red-700 text-red-300'
              : status === 'done'
              ? 'bg-green-950 border border-green-700 text-green-300'
              : 'bg-gray-800 border border-gray-600 text-gray-300'
          }`}
        >
          {message}
        </div>
      )}

      {downloadUrl && (
        <a
          href={downloadUrl}
          download={fileName}
          className="mt-4 flex items-center justify-center gap-2 w-full py-3 rounded-lg
            bg-green-700 hover:bg-green-600 font-semibold text-sm transition-colors"
        >
          ⬇️ Pobierz {fileName}
        </a>
      )}

      <div className="mt-10 text-xs text-gray-600 space-y-1 border-t border-gray-800 pt-4">
        <p>Reguły przetwarzania:</p>
        <ul className="list-disc list-inside space-y-0.5 ml-1">
          <li>Tylko faktury z terminem wymagalności ≥ 47 dni temu</li>
          <li>Klienci z łącznym zadłużeniem &lt; 500 PLN są pomijani</li>
          <li>Daty wysłania wezwań: z poprzedniego KRD lub termin + 7 dni</li>
          <li>Wytwórcy (raport fakturowania) są wykluczani z listy</li>
          <li>Kodowanie: CP1250, separator: średnik</li>
        </ul>
      </div>
    </main>
  )
}

import { useState } from 'react'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8080'

type HelloResponse = {
  message: string
  hostname: string
  timestamp: string
}

function App() {
  const [health, setHealth] = useState<string>('unknown')
  const [hello, setHello] = useState<HelloResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const checkHealth = async () => {
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/health`)
      const data = await res.json()
      setHealth(data.status)
    } catch {
      setHealth('unreachable')
      setError('Could not reach backend health endpoint')
    }
  }

  const callHello = async () => {
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/hello`)
      const data: HelloResponse = await res.json()
      setHello(data)
    } catch {
      setHello(null)
      setError('Could not reach backend hello endpoint')
    }
  }

  return (
    <main style={{ fontFamily: 'sans-serif', maxWidth: 480, margin: '4rem auto' }}>
      <h1>Dummy Frontend</h1>
      <p>
        Backend URL: <code>{API_URL}</code>
      </p>

      <section>
        <button onClick={checkHealth}>Check backend health</button>
        <p>Health: {health}</p>
      </section>

      <section>
        <button onClick={callHello}>Call /api/hello</button>
        {hello && <pre>{JSON.stringify(hello, null, 2)}</pre>}
      </section>

      {error && <p style={{ color: 'red' }}>{error}</p>}
    </main>
  )
}

export default App

import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [results, setResults] = useState([])

  useEffect(() => {
    const fetchResults = async () => {
      try {
        const response = await fetch('https://api.example.com/live-race-results')
        //const data = await response.json()
        const data = [
          { position: 1, driver: 'Driver 1', time: '1:23.456' },
          { position: 2, driver: 'Driver 2', time: '1:24.567' },
          { position: 3, driver: 'Driver 3', time: '1:25.678' },
        ]
        setResults(data)
      } catch (error) {
        console.error('Error fetching race results:', error)
      }
    }
    
    fetchResults()
    const interval = setInterval(fetchResults, 5000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="App">
      <header className="App-header">
        <h1>Live Race Scoreboard</h1>
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Driver</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result, index) => (
              <tr key={index}>
                <td>{result.position}</td>
                <td>{result.driver}</td>
                <td>{result.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </header>
    </div>
  )
}

export default App

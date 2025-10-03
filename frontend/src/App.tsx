import React, { useState, useEffect } from 'react';
import './App.css';

const API_BASE_URL = 'https://dexhfll527.execute-api.us-east-1.amazonaws.com/prod';

interface ProcessingResult {
  documentId: string;
  fileName: string;
  status: string;
  ocrResults?: any;
  classification?: string;
  summary?: string;
  errorMessage?: string;
  createdAt: string;
}

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [results, setResults] = useState<ProcessingResult | null>(null);
  const [polling, setPolling] = useState(false);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setResults(null);
      setDocumentId(null);
    }
  };

  const uploadDocument = async () => {
    if (!selectedFile) return;

    setUploading(true);
    try {
      // Get pre-signed URL
      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName: selectedFile.name,
          contentType: selectedFile.type,
        }),
      });

      const data = await response.json();
      const { uploadUrl, documentId: newDocumentId } = data;

      // Upload file to S3
      await fetch(uploadUrl, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': selectedFile.type,
        },
      });

      setDocumentId(newDocumentId);
      setPolling(true);
      
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const fetchResults = async (docId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/results/${docId}`);
      const data = await response.json();
      
      if (data.documentId) {
        setResults(data);
        
        // Stop polling if processing is complete or failed
        if (data.status === 'complete' || data.status.includes('failed')) {
          setPolling(false);
        }
      }
    } catch (error) {
      console.error('Error fetching results:', error);
    }
  };

  // Polling effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    
    if (polling && documentId) {
      interval = setInterval(() => {
        fetchResults(documentId);
      }, 2000);
    }

    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [polling, documentId]);

  const getStatusColor = (status: string) => {
    if (status === 'complete') return '#4CAF50';
    if (status.includes('failed')) return '#f44336';
    return '#ff9800';
  };

  const formatOcrResults = (ocrResults: any) => {
    if (!ocrResults) return 'No OCR results available';
    
    if (typeof ocrResults === 'object') {
      return Object.entries(ocrResults)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
    }
    
    return JSON.stringify(ocrResults, null, 2);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Intelligent Document Processing</h1>
        <p>Upload documents for OCR, classification, and summarization</p>
      </header>

      <main className="App-main">
        <div className="upload-section">
          <h2>Upload Document</h2>
          <div className="file-input-container">
            <input
              type="file"
              onChange={handleFileSelect}
              accept="image/*,.pdf"
              disabled={uploading}
            />
            {selectedFile && (
              <p>Selected: {selectedFile.name}</p>
            )}
          </div>
          
          <button
            onClick={uploadDocument}
            disabled={!selectedFile || uploading}
            className="upload-button"
          >
            {uploading ? 'Uploading...' : 'Upload Document'}
          </button>
        </div>

        {results && (
          <div className="results-section">
            <h2>Processing Results</h2>
            
            <div className="status-card">
              <h3>Status</h3>
              <p style={{ color: getStatusColor(results.status) }}>
                {results.status.toUpperCase()}
                {polling && ' (Processing...)'}
              </p>
              <p><strong>Document:</strong> {results.fileName}</p>
              <p><strong>Uploaded:</strong> {new Date(results.createdAt).toLocaleString()}</p>
            </div>

            {results.ocrResults && (
              <div className="result-card">
                <h3>OCR Results</h3>
                <pre className="result-content">
                  {formatOcrResults(results.ocrResults)}
                </pre>
              </div>
            )}

            {results.classification && (
              <div className="result-card">
                <h3>Document Classification</h3>
                <p className="classification-result">{results.classification}</p>
              </div>
            )}

            {results.summary && (
              <div className="result-card">
                <h3>Document Summary</h3>
                <p className="summary-result">{results.summary}</p>
              </div>
            )}

            {results.errorMessage && (
              <div className="result-card error">
                <h3>Error</h3>
                <p>{results.errorMessage}</p>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;

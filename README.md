# Intelligent Document Processing (IDP) Application

A serverless document processing application built with AWS services that performs OCR, classification, and summarization on uploaded documents.

## Architecture

The application follows a serverless architecture using:

- **Frontend**: React TypeScript application
- **API**: AWS API Gateway with Lambda functions
- **Storage**: S3 for documents, DynamoDB for results
- **AI Processing**: AWS Textract for OCR, AWS Bedrock (Claude Sonnet) for classification and summarization

## Features

### Document Processing Pipeline
1. **OCR Processing**: Extracts text content from documents using AWS Textract
2. **Document Classification**: Classifies documents into predefined categories:
   - Dietary Supplement
   - Stationery
   - Kitchen Supplies
   - Medicine
   - Driver License
   - Invoice
   - W2
   - Other
3. **Document Summarization**: Generates concise summaries using AWS Bedrock

### User Interface
- Simple file upload interface
- Real-time processing status updates
- Display of OCR results, classification, and summary
- Responsive design for mobile and desktop

## Project Structure

```
idp-application-100320251835/
├── specs/                          # Specification documents
│   ├── requirements.md             # User stories and acceptance criteria
│   ├── design.md                   # Technical architecture
│   └── tasks.md                    # Implementation plan
├── infrastructure/                 # AWS CDK infrastructure code
│   ├── lib/
│   │   └── idp-application-100320251835-stack.ts
│   ├── bin/
│   │   └── infrastructure.ts
│   └── package.json
├── frontend/                       # React frontend application
│   ├── src/
│   │   ├── App.tsx                 # Main application component
│   │   └── App.css                 # Styling
│   └── package.json
├── generated-diagrams/             # Architecture diagrams
└── README.md
```

## Deployment

### Prerequisites
- AWS CLI configured with appropriate permissions
- Node.js 18+ installed
- CDK CLI installed (`npm install -g aws-cdk`)

### Infrastructure Deployment
```bash
cd infrastructure
npm install
npm run build
cdk deploy
```

### Frontend Development
```bash
cd frontend
npm install
npm start
```

## API Endpoints

### POST /upload
Upload a document and get a pre-signed URL for S3 upload.

**Request:**
```json
{
  "fileName": "document.pdf",
  "contentType": "application/pdf"
}
```

**Response:**
```json
{
  "uploadUrl": "https://s3-presigned-url...",
  "documentId": "1234567890"
}
```

### GET /results/{documentId}
Get processing results for a document.

**Response:**
```json
{
  "documentId": "1234567890",
  "fileName": "document.pdf",
  "status": "complete",
  "ocrResults": {...},
  "classification": "Invoice",
  "summary": "This document is an invoice...",
  "createdAt": "2025-10-03T23:01:43.464Z"
}
```

## Processing Status Values

- `uploaded`: Document uploaded to S3
- `ocr_complete`: OCR processing finished
- `classification_complete`: Classification finished
- `complete`: All processing stages finished
- `*_failed`: Processing failed at specific stage

## AWS Resources Created

- **S3 Bucket**: `idp-documents-100320251835`
- **DynamoDB Table**: `idp-results-100320251835`
- **Lambda Functions**:
  - `idp-upload-handler-100320251835`
  - `idp-ocr-processor-100320251835`
  - `idp-classification-processor-100320251835`
  - `idp-summarization-processor-100320251835`
  - `idp-results-retriever-100320251835`
- **API Gateway**: `idp-api-100320251835`

## Security Features

- IAM roles with least privilege access
- CORS configuration for frontend access
- Pre-signed URLs for secure S3 uploads
- Encryption at rest for DynamoDB

## Cost Optimization

- Provisioned DynamoDB billing mode for predictable costs
- S3 lifecycle policies for automatic cleanup
- Lambda functions with appropriate timeout settings
- API Gateway caching where applicable

## Testing

The application has been tested end-to-end with:
- Document upload via API
- OCR processing with AWS Textract
- Classification using AWS Bedrock Claude Sonnet
- Summarization using AWS Bedrock Claude Sonnet
- Results retrieval and display

## Monitoring

All Lambda functions include CloudWatch logging for debugging and monitoring. Check the following log groups:
- `/aws/lambda/idp-upload-handler-100320251835`
- `/aws/lambda/idp-ocr-processor-100320251835`
- `/aws/lambda/idp-classification-processor-100320251835`
- `/aws/lambda/idp-summarization-processor-100320251835`
- `/aws/lambda/idp-results-retriever-100320251835`

## Cleanup

To remove all AWS resources:
```bash
cd infrastructure
cdk destroy
```

## License

This project is created as a prototype for demonstration purposes.

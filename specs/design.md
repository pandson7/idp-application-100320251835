# Design Document

## Architecture Overview

The IDP application follows a serverless architecture using AWS services for scalability and cost-effectiveness. The system consists of a React frontend, API Gateway for REST endpoints, Lambda functions for processing logic, S3 for document storage, DynamoDB for results storage, and AWS Bedrock for AI processing.

## System Components

### Frontend Layer
- **React Application**: Simple web interface for document upload and results display
- **File Upload Component**: Handles document selection and upload to S3
- **Results Display Component**: Shows processing status and final results

### API Layer
- **API Gateway**: RESTful endpoints for frontend communication
- **Lambda Functions**:
  - Upload Handler: Manages document upload to S3
  - OCR Processor: Handles Textract integration
  - Classification Processor: Performs document classification using Bedrock
  - Summarization Processor: Generates document summaries using Bedrock
  - Results Retriever: Fetches processing results from DynamoDB

### Storage Layer
- **S3 Bucket**: Stores uploaded documents with lifecycle policies
- **DynamoDB Table**: Flexible schema for storing processing results and metadata

### AI Processing Layer
- **AWS Textract**: OCR processing for text extraction
- **AWS Bedrock**: Claude Sonnet model for classification and summarization

## Data Flow

### Document Upload Flow
1. User selects document in React frontend
2. Frontend uploads document directly to S3 using pre-signed URL
3. S3 upload triggers Lambda function via S3 event
4. Lambda function creates initial record in DynamoDB with "processing" status

### IDP Pipeline Flow
1. **OCR Stage**: 
   - Lambda function calls Textract to extract text
   - Results stored as key-value pairs in JSON format
   - DynamoDB updated with OCR results
2. **Classification Stage**:
   - Lambda function sends OCR text to Bedrock Claude model
   - Model classifies document into predefined categories
   - Classification result and confidence stored in DynamoDB
3. **Summarization Stage**:
   - Lambda function sends OCR text to Bedrock Claude model
   - Model generates document summary
   - Summary stored in DynamoDB and status updated to "complete"

### Results Display Flow
1. Frontend polls API Gateway endpoint for processing status
2. Lambda function retrieves current results from DynamoDB
3. Results displayed in frontend with appropriate status indicators

## Security Considerations

- **IAM Roles**: Least privilege access for all Lambda functions
- **S3 Bucket Policies**: Restricted access with pre-signed URLs for uploads
- **API Gateway**: CORS configuration for frontend access
- **DynamoDB**: Encryption at rest enabled

## Scalability Design

- **Lambda Concurrency**: Auto-scaling based on demand
- **DynamoDB**: Provisioned billing mode for predictable performance
- **S3**: Automatic scaling for document storage
- **API Gateway**: Built-in throttling and caching

## Error Handling

- **Retry Logic**: Exponential backoff for transient failures
- **Dead Letter Queues**: For failed processing attempts
- **Logging**: CloudWatch logs for debugging and monitoring
- **Status Tracking**: Detailed status updates in DynamoDB

## Performance Considerations

- **Asynchronous Processing**: Non-blocking pipeline execution
- **Caching**: API Gateway response caching where appropriate
- **Optimized Payloads**: Minimal data transfer between components
- **Connection Pooling**: Efficient database connections

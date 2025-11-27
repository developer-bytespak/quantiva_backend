export default () => ({
  kyc: {
    pythonApiUrl: process.env.PYTHON_API_URL || 'http://localhost:8000',
    faceMatchThreshold: parseFloat(process.env.KYC_FACE_MATCH_THRESHOLD || '0.8'),
    livenessConfidenceThreshold: parseFloat(
      process.env.KYC_LIVENESS_CONFIDENCE_THRESHOLD || '0.7',
    ),
    docAuthenticityThreshold: parseFloat(
      process.env.KYC_DOC_AUTHENTICITY_THRESHOLD || '0.75',
    ),
    maxFileSize: parseInt(process.env.KYC_MAX_FILE_SIZE || '10485760', 10), // 10MB default
    allowedMimeTypes: [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
      'video/mp4',
      'video/webm',
    ],
    storageRoot: process.env.STORAGE_ROOT || './storage',
  },
});


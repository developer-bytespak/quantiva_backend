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
    // Sumsub configuration
    sumsub: {
      appToken: process.env.SUMSUB_APP_TOKEN || '',
      secretKey: process.env.SUMSUB_SECRET_KEY || '',
      baseUrl: process.env.SUMSUB_BASE_URL || 'https://api.sumsub.com',
      levelName: process.env.SUMSUB_LEVEL_NAME || 'basic-kyc-level',
      webhookSecret: process.env.SUMSUB_WEBHOOK_SECRET || '',
    },
  },
});


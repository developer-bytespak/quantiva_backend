import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
  accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '45m',
  refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  cookieDomain: process.env.COOKIE_DOMAIN,
  isProduction: process.env.NODE_ENV === 'production',
}));

export class AuthResponseDto {
  user: {
    user_id: string;
    email: string;
    username: string;
    email_verified: boolean;
    kyc_status: string;
  };
  requires2FA?: boolean;
  message?: string;
}


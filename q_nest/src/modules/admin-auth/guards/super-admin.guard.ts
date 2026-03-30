import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const admin = request.user as { is_super_admin?: boolean } | undefined;

    if (!admin?.is_super_admin) {
      throw new ForbiddenException(
        'Only super admins can access this resource',
      );
    }

    return true;
  }
}

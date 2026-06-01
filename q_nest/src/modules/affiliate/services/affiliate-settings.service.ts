import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { UpdateAffiliateSettingsDto } from '../dto/update-affiliate-settings.dto';

@Injectable()
export class AffiliateSettingsService {
  constructor(private prisma: PrismaService) {}

  async getSettings(affiliateId: string) {
    const affiliate = await this.prisma.affiliates.findUnique({
      where: { affiliate_id: affiliateId },
      select: {
        affiliate_id: true,
        email: true,
        display_name: true,
        full_name: true,
        country: true,
        tax_residency: true,
        payout_instructions: true,
        tax_form_url: true,
        commission_tier: true,
        status: true,
      },
    });
    if (!affiliate) throw new NotFoundException('Affiliate not found');
    return affiliate;
  }

  async updateSettings(
    affiliateId: string,
    dto: UpdateAffiliateSettingsDto,
  ) {
    const data: Record<string, string | null> = {};
    if (dto.full_name !== undefined) data.full_name = dto.full_name;
    if (dto.country !== undefined) data.country = dto.country;
    if (dto.tax_residency !== undefined) data.tax_residency = dto.tax_residency;
    if (dto.payout_instructions !== undefined)
      data.payout_instructions = dto.payout_instructions;
    if (dto.tax_form_url !== undefined) data.tax_form_url = dto.tax_form_url;

    const updated = await this.prisma.affiliates.update({
      where: { affiliate_id: affiliateId },
      data,
      select: {
        affiliate_id: true,
        email: true,
        display_name: true,
        full_name: true,
        country: true,
        tax_residency: true,
        payout_instructions: true,
        tax_form_url: true,
      },
    });

    await this.prisma.affiliate_audit_log.create({
      data: {
        affiliate_id: affiliateId,
        action: 'AFFILIATE_SETTINGS_UPDATED',
        metadata: { fields_updated: Object.keys(data) },
      },
    });

    return updated;
  }

  /**
   * Static marketing-asset catalog for the affiliate /assets page. Empty
   * collections at v1; real assets uploaded by the team later.
   */
  getAssets() {
    return {
      logos: [],
      banners: [],
      copy_templates: [],
      videos: [],
      brand_guidelines_url: null,
    };
  }
}

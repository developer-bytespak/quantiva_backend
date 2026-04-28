import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const BASE_LAYOUT = '_base.html';
const STAGE_PREFIXES = ['signed_up', 'personal_info', 'kyc', 'paid', 'free_upgrade'];

export interface RenderedTemplate {
  subject: string;
  html: string;
}

@Injectable()
export class TemplateRendererService {
  private readonly logger = new Logger(TemplateRendererService.name);
  private readonly cache = new Map<string, string>();

  async exists(templateName: string): Promise<boolean> {
    if (this.cache.has(`${templateName}.html`)) return true;
    const fullPath = path.join(TEMPLATES_DIR, `${templateName}.html`);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  async render(templateName: string, vars: Record<string, string>): Promise<RenderedTemplate> {
    const body = await this.loadTemplate(`${templateName}.html`);
    const layout = await this.loadTemplate(BASE_LAYOUT);

    const subject = this.extractSubject(body) ?? this.fallbackSubject(templateName);
    const bodyWithoutSubject = this.stripSubject(body);

    const stage = this.resolveStage(templateName);
    const hero = stage ? await this.loadHero(stage) : '';

    const allVars: Record<string, string> = {
      frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      ...vars,
    };

    const interpolatedBody = this.interpolate(bodyWithoutSubject, allVars);
    const html = this.interpolate(
      layout
        .replace('{{body}}', interpolatedBody)
        .replace('{{hero}}', hero),
      allVars,
    );

    return { subject, html };
  }

  private resolveStage(templateName: string): string | null {
    for (const stage of STAGE_PREFIXES) {
      if (templateName.startsWith(`${stage}_`)) return stage;
    }
    return null;
  }

  private async loadHero(stage: string): Promise<string> {
    try {
      return await this.loadTemplate(`illustrations/${stage}.html`);
    } catch {
      this.logger.warn(`No illustration found for stage: ${stage}`);
      return '';
    }
  }

  private async loadTemplate(filename: string): Promise<string> {
    const cached = this.cache.get(filename);
    if (cached !== undefined) return cached;

    const fullPath = path.join(TEMPLATES_DIR, filename);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      this.cache.set(filename, content);
      return content;
    } catch (error) {
      this.logger.error(`Template not found: ${fullPath}`);
      throw new Error(`template_missing:${filename}`);
    }
  }

  private extractSubject(body: string): string | null {
    const match = body.match(/<!--\s*subject:\s*(.+?)\s*-->/);
    return match ? match[1] : null;
  }

  private stripSubject(body: string): string {
    return body.replace(/<!--\s*subject:\s*.+?\s*-->\s*/, '');
  }

  private fallbackSubject(templateName: string): string {
    return `QuantivaHQ — ${templateName}`;
  }

  private interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      return vars[key] ?? '';
    });
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const BASE_LAYOUT = '_base.html';

export interface RenderedTemplate {
  subject: string;
  html: string;
}

@Injectable()
export class TemplateRendererService {
  private readonly logger = new Logger(TemplateRendererService.name);
  private readonly cache = new Map<string, string>();

  async render(templateName: string, vars: Record<string, string>): Promise<RenderedTemplate> {
    const body = await this.loadTemplate(`${templateName}.html`);
    const layout = await this.loadTemplate(BASE_LAYOUT);

    const subject = this.extractSubject(body) ?? this.fallbackSubject(templateName);
    const bodyWithoutSubject = this.stripSubject(body);

    const interpolatedBody = this.interpolate(bodyWithoutSubject, vars);
    const html = this.interpolate(layout.replace('{{body}}', interpolatedBody), vars);

    return { subject, html };
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

  // Templates may declare a subject as the first line: <!-- subject: ... -->
  private extractSubject(body: string): string | null {
    const match = body.match(/<!--\s*subject:\s*(.+?)\s*-->/);
    return match ? match[1] : null;
  }

  private stripSubject(body: string): string {
    return body.replace(/<!--\s*subject:\s*.+?\s*-->\s*/, '');
  }

  private fallbackSubject(templateName: string): string {
    return `Quantiva — ${templateName}`;
  }

  private interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
      return vars[key] ?? '';
    });
  }
}

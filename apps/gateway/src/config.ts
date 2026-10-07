import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '..', 'config');

// Simple template engine: replaces {{key}} placeholders and handles {{#if key}}...{{/if}} blocks
function renderTemplate(template: string, vars: Record<string, string>): string {
  // Handle {{#if key}}...{{/if}} blocks
  let result = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, content) => vars[key] ? content : ''
  );

  // Replace {{key}} placeholders
  result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');

  // Clean up excessive blank lines
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  return result;
}

// Load a prompt template from config/prompts/<name>.md
export function loadPromptTemplate(name: string): string | null {
  const path = join(CONFIG_DIR, 'prompts', `${name}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// Render a prompt template with variables
export function renderPrompt(name: string, vars: Record<string, string>): string | null {
  const template = loadPromptTemplate(name);
  if (!template) return null;
  return renderTemplate(template, vars);
}

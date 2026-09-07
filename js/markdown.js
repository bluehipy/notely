// Lightweight markdown parser - Notely

/**
 * Parse markdown text to HTML
 * Supports: bold, italic, bullets, checkboxes
 * @param {string} text - Raw markdown text
 * @returns {string} HTML string
 */
function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function parseMarkdown(text) {
  if (!text) return '';

  const lines = text.split('\n');
  const htmlLines = [];
  let inBulletList = false;

  lines.forEach((line, lineIndex) => {
    let html = line;

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      if (inBulletList) { htmlLines.push('</ul>'); inBulletList = false; }
      const level = headingMatch[1].length;
      htmlLines.push(`<h${level}>${processInlineFormatting(headingMatch[2])}</h${level}>`);
      return;
    }

    // Check if this is a checkbox line
    if (/^\s*\[[ x]\]/i.test(line)) {
      const isChecked = /^\s*\[x\]/i.test(line);
      const taskText = line.replace(/^\s*\[[ x]\]\s*/i, '');
      const processedText = processInlineFormatting(taskText);

      if (isChecked) {
        html = `<label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
          <input type="checkbox" class="checkbox" checked data-line="${lineIndex}">
          <span style="text-decoration: line-through; color: var(--color-text-muted);">${processedText}</span>
        </label>`;
      } else {
        html = `<label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
          <input type="checkbox" class="checkbox" data-line="${lineIndex}">
          <span>${processedText}</span>
        </label>`;
      }
      htmlLines.push(html);
      return;
    }

    // Check if this is a bullet line
    if (/^\s*-\s/.test(line)) {
      const bulletText = line.replace(/^\s*-\s/, '');
      const processedText = processInlineFormatting(bulletText);

      if (!inBulletList) {
        htmlLines.push('<ul>');
        inBulletList = true;
      }
      htmlLines.push(`<li>${processedText}</li>`);
      return;
    }

    // Close bullet list if we were in one
    if (inBulletList) {
      htmlLines.push('</ul>');
      inBulletList = false;
    }

    // Process inline formatting for regular lines (also handles escaping)
    html = processInlineFormatting(line);

    // Add line break for non-empty lines
    if (html.trim()) {
      htmlLines.push(html);
    } else {
      htmlLines.push('<br>');
    }
  });

  // Close any open bullet list at the end
  if (inBulletList) {
    htmlLines.push('</ul>');
  }

  return htmlLines.join('\n');
}

/**
 * Process inline formatting (bold, italic)
 * @param {string} text - Text to process
 * @returns {string} Processed HTML
 */
function processInlineFormatting(text) {
  // HTML-escape first, then apply markdown (so user text can't inject HTML)
  let result = esc(text);

  // Bold: **text** → <strong>text</strong>
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* → <em>text</em>
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Inline code: `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');

  return result;
}

/**
 * Toggle checkbox state in markdown text
 * @param {string} markdownText - Full markdown text
 * @param {number} lineIndex - 0-based line index to toggle
 * @returns {string} Updated markdown text
 */
export function toggleCheckbox(markdownText, lineIndex) {
  const lines = markdownText.split('\n');

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return markdownText;
  }

  const line = lines[lineIndex];

  // Toggle [ ] to [x] or [x] to [ ]
  if (/^\s*\[ \]/.test(line)) {
    lines[lineIndex] = line.replace(/^\s*\[ \]/, '[x]');
  } else if (/^\s*\[x\]/i.test(line)) {
    lines[lineIndex] = line.replace(/^\s*\[x\]/i, '[ ]');
  }

  return lines.join('\n');
}

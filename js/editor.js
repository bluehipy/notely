// Editor functionality - Notely

import { db } from './db.js';
import { store } from './store.js';
import { parseMarkdown, toggleCheckbox } from './markdown.js';
import { renderNoteList, showToast } from './render.js';

let titleInput = null;
let textarea = null;
let previewDiv = null;
let statusIndicator = null;
let toolbar = null;

// Debounce timers
let debounceTimer = null;
let maxWaitTimer = null;
let isSaving = false;

/**
 * Initialize editor
 */
export function initEditor() {
  titleInput = document.querySelector('.editor-title');
  textarea = document.querySelector('.editor-textarea');
  previewDiv = document.querySelector('.editor-preview');
  statusIndicator = document.querySelector('.status-indicator');
  toolbar = document.querySelector('.editor-toolbar');

  if (!titleInput || !textarea) {
    // Editor not rendered yet (no note selected)
    return;
  }

  // Set up title input listener
  titleInput.addEventListener('input', handleTitleInput);

  // Set up textarea listener
  textarea.addEventListener('input', handleTextareaInput);

  // Set up toolbar (tabs + formatting buttons)
  if (toolbar) {
    toolbar.addEventListener('click', handleToolbarClick);
  }

  // Drop zone on the editor panel
  const editorPanel = document.getElementById('editor');
  if (editorPanel) {
    editorPanel.addEventListener('dragover', handleDragOver);
    editorPanel.addEventListener('dragleave', handleDragLeave);
    editorPanel.addEventListener('drop', handleDrop);
  }
}

function handleDragOver(e) {
  e.preventDefault();
  document.getElementById('editor')?.classList.add('drag-over');
}

function handleDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) {
    document.getElementById('editor')?.classList.remove('drag-over');
  }
}

async function handleDrop(e) {
  e.preventDefault();
  document.getElementById('editor')?.classList.remove('drag-over');
  if (!store.currentNote) return;

  const items = e.dataTransfer.items;
  const urlText = e.dataTransfer.getData('text/plain');
  const urlLink = e.dataTransfer.getData('text/uri-list');

  // URL drop (link dragged from browser)
  const droppedUrl = urlLink || (isUrl(urlText) ? urlText : null);
  if (droppedUrl && (!items || items.length === 0 || [...items].every(i => i.kind === 'string'))) {
    await saveAttachment({ type: 'url', name: droppedUrl, data: droppedUrl, mime_type: 'text/uri-list', size: 0 });
    return;
  }

  // File drop
  const files = e.dataTransfer.files;
  for (const file of files) {
    await readAndSaveFile(file);
  }
}

function isUrl(str) {
  try { return Boolean(new URL(str)) && /^https?:\/\//.test(str); } catch { return false; }
}

async function readAndSaveFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const type = file.type.startsWith('image/') ? 'image' : 'file';
      await saveAttachment({
        type,
        name: file.name,
        mime_type: file.type,
        data: e.target.result, // base64 data URL
        size: file.size
      });
      resolve();
    };
    reader.readAsDataURL(file);
  });
}

async function saveAttachment(attachment) {
  try {
    await db.run(
      "INSERT INTO attachments (note_id, type, name, mime_type, data, size) VALUES (?, ?, ?, ?, ?, ?)",
      [store.currentNote, attachment.type, attachment.name, attachment.mime_type, attachment.data, attachment.size]
    );
    await refreshAttachmentTray();
  } catch (err) {
    showToast('Could not save attachment.', 'error');
    console.error('Attachment save failed:', err);
  }
}

export async function refreshAttachmentTray() {
  const tray = document.querySelector('.attachment-tray');
  if (!tray || !store.currentNote) return;
  const attachments = await db.all('SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at ASC', [store.currentNote]);
  tray.innerHTML = renderAttachmentTrayHTML(attachments);
  tray.querySelectorAll('[data-action="delete-attachment"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await db.run('DELETE FROM attachments WHERE id = ?', [parseInt(btn.dataset.id)]);
      await refreshAttachmentTray();
    });
  });

  // Image lightbox
  tray.querySelectorAll('.attachment-image img').forEach(img => {
    img.style.cursor = 'zoom-in';
    img.addEventListener('click', () => openLightbox(img.src, img.alt));
  });
}

function openLightbox(src, alt) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox-overlay';
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt || '';
  overlay.appendChild(img);
  overlay.addEventListener('click', () => overlay.remove());
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
  });
  document.body.appendChild(overlay);
}

function renderAttachmentTrayHTML(attachments) {
  if (!attachments.length) return '';
  return attachments.map(a => {
    if (a.type === 'image') {
      return `<div class="attachment-chip attachment-image" title="${escAttrib(a.name)}">
        <img src="${a.data}" alt="${escAttrib(a.name)}" />
        <button class="attachment-delete" data-action="delete-attachment" data-id="${a.id}" title="Remove">×</button>
      </div>`;
    }
    if (a.type === 'url') {
      return `<div class="attachment-chip attachment-url">
        <a href="${escAttrib(a.data)}" target="_blank" rel="noopener noreferrer">🔗 ${escAttrib(a.name.length > 50 ? a.name.slice(0, 50) + '…' : a.name)}</a>
        <button class="attachment-delete" data-action="delete-attachment" data-id="${a.id}" title="Remove">×</button>
      </div>`;
    }
    // generic file
    const kb = a.size ? `${Math.round(a.size / 1024)} KB` : '';
    return `<div class="attachment-chip attachment-file">
      <a href="${a.data}" download="${escAttrib(a.name)}">📎 ${escAttrib(a.name)}${kb ? ` <span class="attachment-size">${kb}</span>` : ''}</a>
      <button class="attachment-delete" data-action="delete-attachment" data-id="${a.id}" title="Remove">×</button>
    </div>`;
  }).join('');
}

function escAttrib(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Handle title input with debounced save
 */
function handleTitleInput(event) {
  const newTitle = event.target.value;

  // Update store.notes in real-time (for note list)
  const noteIndex = store.notes.findIndex(n => n.id === store.currentNote);
  if (noteIndex !== -1) {
    store.notes[noteIndex].title = newTitle;
    renderNoteList();
  }

  // Trigger debounced save
  debouncedSave();
}

/**
 * Handle textarea input with debounced save and preview update
 */
function handleTextareaInput(event) {
  const newBody = event.target.value;

  // Update store.notes in real-time
  const noteIndex = store.notes.findIndex(n => n.id === store.currentNote);
  if (noteIndex !== -1) {
    store.notes[noteIndex].body = newBody;
  }

  // Trigger debounced save
  debouncedSave();
}

/**
 * Debounced save with 300ms debounce and 2000ms maxWait
 */
function debouncedSave() {
  // Clear existing debounce timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Start maxWait timer if not already running
  if (!maxWaitTimer && !isSaving) {
    maxWaitTimer = setTimeout(() => {
      executeSave();
    }, 2000);
  }

  // Set debounce timer
  debounceTimer = setTimeout(() => {
    executeSave();
  }, 300);
}

/**
 * Execute save and clear timers
 */
async function executeSave() {
  // Clear both timers
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }

  await saveNote();
}

/**
 * Save note to database with retry logic
 */
async function saveNote() {
  if (!store.currentNote || isSaving) return;

  isSaving = true;

  // Update status
  if (statusIndicator) {
    statusIndicator.textContent = 'Saving...';
    statusIndicator.classList.add('saving');
  }

  const title = titleInput?.value || '';
  const body = textarea?.value || '';

  // Retry logic
  const maxRetries = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxRetries) {
    try {
      // Update database
      await db.run(
        "UPDATE notes SET title = ?, body = ?, updated_at = datetime('now') WHERE id = ?",
        [title, body, store.currentNote]
      );

      // Update store.notes with new updated_at (approximate - we don't fetch it back)
      const noteIndex = store.notes.findIndex(n => n.id === store.currentNote);
      if (noteIndex !== -1) {
        store.notes[noteIndex].title = title;
        store.notes[noteIndex].body = body;
        store.notes[noteIndex].updated_at = new Date().toISOString();
      }

      // Update status
      if (statusIndicator) {
        statusIndicator.textContent = 'Saved';
        statusIndicator.classList.remove('saving');
      }

      console.log('Note saved:', store.currentNote);
      isSaving = false;
      return; // Success - exit
    } catch (error) {
      lastError = error;
      attempt++;

      console.error(`Save failed (attempt ${attempt}/${maxRetries}):`, error);

      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt - 1) * 500; // 500ms, 1s, 2s
        if (statusIndicator) {
          statusIndicator.textContent = `Save failed - Retrying...`;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // All retries failed
  if (statusIndicator) {
    statusIndicator.textContent = 'Save failed';
    statusIndicator.classList.remove('saving');
  }

  showToast('Could not save changes. Check your connection.', 'error');
  isSaving = false;
}

/**
 * Handle toolbar button clicks
 */
function handleToolbarClick(event) {
  const tab = event.target.closest('.editor-tab');
  if (tab) {
    const action = tab.dataset.action;
    if (action === 'tab-preview') switchTab('preview');
    else if (action === 'tab-write') switchTab('write');
    return;
  }

  const button = event.target.closest('.toolbar-button');
  if (!button || !textarea) return;

  const action = button.dataset.action;

  switch (action) {
    case 'bold':    insertMarkdown('**', '**'); break;
    case 'italic':  insertMarkdown('*', '*');   break;
    case 'bullet':  insertMarkdown('- ', '');   break;
    case 'checkbox':insertMarkdown('[ ] ', ''); break;
  }
}

function switchTab(mode) {
  if (!toolbar) return;
  const writeTab    = toolbar.querySelector('[data-action="tab-write"]');
  const previewTab  = toolbar.querySelector('[data-action="tab-preview"]');
  const formatBtns  = toolbar.querySelector('.editor-format-buttons');

  if (mode === 'preview') {
    renderPreview(textarea.value);
    textarea.hidden   = true;
    previewDiv.hidden = false;
    writeTab?.classList.remove('active');
    previewTab?.classList.add('active');
    if (formatBtns) formatBtns.style.visibility = 'hidden';
  } else {
    textarea.hidden   = false;
    previewDiv.hidden = true;
    writeTab?.classList.add('active');
    previewTab?.classList.remove('active');
    if (formatBtns) formatBtns.style.visibility = '';
    textarea.focus();
  }
}

/**
 * Insert markdown syntax around selected text
 * @param {string} before - Text to insert before selection
 * @param {string} after - Text to insert after selection
 */
export function insertMarkdown(before, after = '') {
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selectedText = textarea.value.substring(start, end);
  const beforeText = textarea.value.substring(0, start);
  const afterText = textarea.value.substring(end);

  // Insert markdown syntax
  let newText;
  let newCursorPos;

  if (selectedText) {
    // Wrap selected text
    newText = beforeText + before + selectedText + after + afterText;
    newCursorPos = start + before.length + selectedText.length + after.length;
  } else {
    // Just insert syntax at cursor
    newText = beforeText + before + after + afterText;
    newCursorPos = start + before.length;
  }

  // Update textarea
  textarea.value = newText;

  // Restore cursor position
  textarea.focus();
  textarea.setSelectionRange(newCursorPos, newCursorPos);

  // Update store
  const noteIndex = store.notes.findIndex(n => n.id === store.currentNote);
  if (noteIndex !== -1) {
    store.notes[noteIndex].body = newText;
  }

  debouncedSave();
}

/**
 * Render markdown preview
 * @param {string} markdown - Markdown text to render
 */
function renderPreview(markdown) {
  if (!previewDiv) return;

  const html = parseMarkdown(markdown);
  previewDiv.innerHTML = html;

  // Attach click handlers to checkboxes
  const checkboxes = previewDiv.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    checkbox.addEventListener('click', handleCheckboxClick);
  });
}

/**
 * Handle checkbox clicks in preview
 */
function handleCheckboxClick(event) {
  const checkbox = event.target;
  const lineIndex = parseInt(checkbox.dataset.line);

  if (isNaN(lineIndex) || !textarea) return;

  // Toggle checkbox in markdown
  const newMarkdown = toggleCheckbox(textarea.value, lineIndex);
  textarea.value = newMarkdown;

  // Update preview
  renderPreview(newMarkdown);

  // Update store
  const noteIndex = store.notes.findIndex(n => n.id === store.currentNote);
  if (noteIndex !== -1) {
    store.notes[noteIndex].body = newMarkdown;
  }

  // Trigger save
  debouncedSave();
}

/**
 * Get current editor state (for external access)
 */
export function getEditorState() {
  return {
    titleInput,
    textarea,
    previewDiv,
    statusIndicator,
    insertMarkdown
  };
}

// Keyboard shortcuts - Notely

import { getEditorState } from './editor.js';
import { store } from './store.js';
import { db } from './db.js';
import { renderNoteList, renderEditor } from './render.js';
import { initEditor } from './editor.js';

// Track focused note index for arrow key navigation
let focusedNoteIndex = -1;

/**
 * Initialize keyboard shortcuts
 * @param {Function} createNoteFn - Function to call for Ctrl+N
 */
export function initShortcuts(createNoteFn) {
  document.addEventListener('keydown', async (event) => {
    // Ctrl+N: Create new note
    if (event.ctrlKey && event.key === 'n') {
      event.preventDefault();
      if (createNoteFn) {
        createNoteFn();
      }
      return;
    }

    // Ctrl+F: Focus search input
    if (event.ctrlKey && event.key === 'f') {
      event.preventDefault();
      const searchInput = document.querySelector('.search-input');
      if (searchInput && !searchInput.disabled) {
        searchInput.focus();
      }
      return;
    }

    // Ctrl+B: Toggle bold
    if (event.ctrlKey && event.key === 'b') {
      event.preventDefault();
      const { textarea, insertMarkdown } = getEditorState();
      if (textarea && insertMarkdown) {
        insertMarkdown('**', '**');
      }
      return;
    }

    // Ctrl+I: Toggle italic
    if (event.ctrlKey && event.key === 'i') {
      event.preventDefault();
      const { textarea, insertMarkdown } = getEditorState();
      if (textarea && insertMarkdown) {
        insertMarkdown('*', '*');
      }
      return;
    }

    // Ctrl+Shift+C: Insert checkbox
    if (event.ctrlKey && event.shiftKey && event.key === 'C') {
      event.preventDefault();
      const { textarea, insertMarkdown } = getEditorState();
      if (textarea && insertMarkdown) {
        insertMarkdown('[ ] ', '');
      }
      return;
    }

    // Escape: Clear search (if search input is focused)
    if (event.key === 'Escape') {
      const searchInput = document.querySelector('.search-input');
      if (searchInput && document.activeElement === searchInput) {
        event.preventDefault();
        searchInput.value = '';
        // Trigger input event to restore previous context
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.blur();
      }
      return;
    }

    // Arrow key navigation in note list
    const noteList = document.getElementById('note-list');
    const noteCards = noteList?.querySelectorAll('.note-card');

    if (noteCards && noteCards.length > 0) {
      const activeInNoteList = Array.from(noteCards).some(card =>
        card.contains(document.activeElement) || document.activeElement === noteList
      );

      if (activeInNoteList || document.activeElement?.closest('.note-card')) {
        // Initialize focusedNoteIndex if not set
        if (focusedNoteIndex === -1) {
          // Find selected note or default to 0
          const selectedIndex = Array.from(noteCards).findIndex(card => card.classList.contains('selected'));
          focusedNoteIndex = selectedIndex >= 0 ? selectedIndex : 0;
        }

        // Arrow Down: Move to next note
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          focusedNoteIndex = Math.min(focusedNoteIndex + 1, noteCards.length - 1);
          updateFocusedNote(noteCards);
          return;
        }

        // Arrow Up: Move to previous note
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          focusedNoteIndex = Math.max(focusedNoteIndex - 1, 0);
          updateFocusedNote(noteCards);
          return;
        }

        // Enter: Select focused note
        if (event.key === 'Enter' && focusedNoteIndex >= 0 && focusedNoteIndex < noteCards.length) {
          event.preventDefault();
          const focusedCard = noteCards[focusedNoteIndex];
          const noteId = parseInt(focusedCard.dataset.id);

          if (noteId) {
            // Select the note
            store.currentNote = noteId;

            // Fetch the full note
            const note = await db.get('SELECT * FROM notes WHERE id = ?', [noteId]);

            renderNoteList();
            await renderEditor(note);
            initEditor();

            // Focus title input
            setTimeout(() => {
              const titleInput = document.querySelector('.editor-title');
              if (titleInput) {
                titleInput.focus();
              }
            }, 50);
          }
          return;
        }
      }
    }
  });
}

/**
 * Update focused note visual state
 * @param {NodeList} noteCards - List of note card elements
 */
function updateFocusedNote(noteCards) {
  noteCards.forEach((card, index) => {
    if (index === focusedNoteIndex) {
      card.classList.add('focused');
      card.focus();
    } else {
      card.classList.remove('focused');
    }
  });
}

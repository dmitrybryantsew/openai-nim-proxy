const state = {
  apiKey: localStorage.getItem('openai-nim-proxy-key') || '',
  decks: [],
  activeDeck: null,
  cards: [],
  currentIndex: 0,
  cardStartTime: 0,
};

const el = {
  apiKeyInput: document.getElementById('apiKeyInput'),
  saveKeyBtn: document.getElementById('saveKeyBtn'),
  deckSelectSection: document.getElementById('deckSelectSection'),
  deckList: document.getElementById('deckList'),
  refreshDecksBtn: document.getElementById('refreshDecksBtn'),
  studySection: document.getElementById('studySection'),
  finishedSection: document.getElementById('finishedSection'),
  currentDeckBadge: document.getElementById('currentDeckBadge'),
  cardProgress: document.getElementById('cardProgress'),
  speakBtn: document.getElementById('speakBtn'),
  exitStudyBtn: document.getElementById('exitStudyBtn'),
  cardQuestionName: document.getElementById('cardQuestionName'),
  cardQuestionText: document.getElementById('cardQuestionText'),
  cardChoices: document.getElementById('cardChoices'),
  typedInputContainer: document.getElementById('typedInputContainer'),
  typedAnswerInput: document.getElementById('typedAnswerInput'),
  showAnswerBtn: document.getElementById('showAnswerBtn'),
  answerArea: document.getElementById('answerArea'),
  cardAnswerText: document.getElementById('cardAnswerText'),
  backToDecksBtn: document.getElementById('backToDecksBtn'),
};

// Setup API key handlers
el.apiKeyInput.value = state.apiKey;
el.saveKeyBtn.addEventListener('click', () => {
  state.apiKey = el.apiKeyInput.value.trim();
  localStorage.setItem('openai-nim-proxy-key', state.apiKey);
  loadDecks();
});

el.refreshDecksBtn.addEventListener('click', loadDecks);
el.exitStudyBtn.addEventListener('click', showDeckSelect);
el.backToDecksBtn.addEventListener('click', showDeckSelect);
el.showAnswerBtn.addEventListener('click', revealAnswer);
el.speakBtn.addEventListener('click', speakCurrentQuestion);

// Grade button handlers
document.querySelectorAll('.grade-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const grade = Number(btn.getAttribute('data-grade'));
    await submitGrade(grade);
  });
});

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (state.apiKey) {
    headers.Authorization = `Bearer ${state.apiKey}`;
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function loadDecks() {
  el.deckList.innerHTML = '<p style="color:#888;">Loading decks...</p>';
  try {
    const res = await api('/api/cards/decks');
    state.decks = res.data || [];
    renderDeckList();
  } catch (err) {
    el.deckList.innerHTML = `<p style="color:#e63946;">Failed to load decks: ${err.message}</p>`;
  }
}

function renderDeckList() {
  el.deckList.innerHTML = '';
  if (state.decks.length === 0) {
    el.deckList.innerHTML = `
      <p style="color:#aaa;">No decks found on server.</p>
      <p style="color:#777; font-size:0.9rem;">Click "Sync with Site" inside Obsidian to upload your flashcards.</p>
    `;
    return;
  }

  for (const deck of state.decks) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.style.cursor = 'pointer';

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <strong>${deck.name}</strong>
        <span class="deck-badge">${deck.dueCards} Due</span>
      </div>
      <span style="color:#aaa; font-size:0.85rem;">Total: ${deck.totalCards} cards</span>
      ${deck.description ? `<p style="font-size:0.8rem; color:#888; margin-top:0.4rem;">${deck.description}</p>` : ''}
    `;

    card.addEventListener('click', () => startStudyDeck(deck));
    el.deckList.appendChild(card);
  }
}

async function startStudyDeck(deck) {
  state.activeDeck = deck;
  el.deckSelectSection.classList.add('hidden');
  el.finishedSection.classList.add('hidden');
  el.studySection.classList.remove('hidden');

  el.currentDeckBadge.textContent = deck.name;
  el.cardProgress.textContent = 'Loading due cards...';

  try {
    const res = await api(`/api/cards/due?deckId=${encodeURIComponent(deck.id)}&limit=100`);
    state.cards = res.data || [];
    state.currentIndex = 0;

    if (state.cards.length === 0) {
      showFinished();
      return;
    }

    renderCurrentCard();
  } catch (err) {
    alert(`Failed to load due cards: ${err.message}`);
    showDeckSelect();
  }
}

function renderCurrentCard() {
  if (state.currentIndex >= state.cards.length) {
    showFinished();
    return;
  }

  const card = state.cards[state.currentIndex];
  state.cardStartTime = Date.now();

  el.cardProgress.textContent = `Card ${state.currentIndex + 1} of ${state.cards.length}`;
  el.cardQuestionName.textContent = card.questionName || card.questionType;
  el.cardQuestionText.textContent = card.questionText;

  // Answer area setup
  el.cardAnswerText.textContent = card.answerText || '(No answer provided)';
  el.showAnswerBtn.classList.remove('hidden');
  el.answerArea.classList.add('hidden');

  // Multiple choice setup
  if (card.questionType === 'multiple_choice' && Array.isArray(card.choices) && card.choices.length > 0) {
    el.cardChoices.innerHTML = '';
    el.cardChoices.classList.remove('hidden');
    el.typedInputContainer.classList.add('hidden');

    for (const choice of card.choices) {
      const choiceBtn = document.createElement('button');
      choiceBtn.className = 'choice-item';
      choiceBtn.textContent = choice;
      choiceBtn.addEventListener('click', () => {
        revealAnswer();
        const isMatch = choice.trim().toLowerCase() === (card.answerText || '').trim().toLowerCase();
        if (isMatch) {
          choiceBtn.style.borderColor = '#52b788';
          choiceBtn.style.background = 'rgba(82, 183, 136, 0.2)';
        } else {
          choiceBtn.style.borderColor = '#e63946';
          choiceBtn.style.background = 'rgba(230, 57, 70, 0.2)';
        }
      });
      el.cardChoices.appendChild(choiceBtn);
    }
  } else if (card.questionType.startsWith('typed_')) {
    el.cardChoices.classList.add('hidden');
    el.typedInputContainer.classList.remove('hidden');
    el.typedAnswerInput.value = '';
  } else {
    el.cardChoices.classList.add('hidden');
    el.typedInputContainer.classList.add('hidden');
  }
}

function revealAnswer() {
  el.showAnswerBtn.classList.add('hidden');
  el.answerArea.classList.remove('hidden');
}

async function submitGrade(grade) {
  const card = state.cards[state.currentIndex];
  const elapsedMs = Date.now() - state.cardStartTime;
  const userAnswer = el.typedAnswerInput.value.trim() || null;

  try {
    await api('/api/cards/review', {
      method: 'POST',
      body: JSON.stringify({
        cardId: card.id,
        grade,
        userAnswer,
        elapsedMs,
      }),
    });
  } catch (err) {
    console.error('Failed to submit review:', err);
  }

  // If grade was 0 (Again), re-add card to end of session
  if (grade === 0) {
    state.cards.push(card);
  }

  state.currentIndex++;
  renderCurrentCard();
}

function showFinished() {
  el.studySection.classList.add('hidden');
  el.finishedSection.classList.remove('hidden');
}

function showDeckSelect() {
  el.studySection.classList.add('hidden');
  el.finishedSection.classList.add('hidden');
  el.deckSelectSection.classList.remove('hidden');
  loadDecks();
}

async function speakCurrentQuestion() {
  const card = state.cards[state.currentIndex];
  if (!card) return;

  const text = card.questionText;

  // Try server TTS first
  try {
    const res = await fetch('/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: state.apiKey ? `Bearer ${state.apiKey}` : undefined,
      },
      body: JSON.stringify({ input: text }),
    });

    if (res.ok) {
      const blob = await res.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      audio.play();
      return;
    }
  } catch {
    // Fall back to Web Speech API
  }

  if ('speechSynthesis' in window) {
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
  }
}

// Initial load
loadDecks();

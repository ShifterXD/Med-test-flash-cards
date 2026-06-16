const STORAGE_KEY = 'fsp-flashcards-srs-v1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const AGAIN_DELAY_MS = 5 * 60 * 1000;

const state = {
  allCards: [],
  cards: [],
  queue: [],
  currentCard: null,
  answerVisible: false,
  progress: {},
  todayReviewed: 0,
};

const els = {
  status: document.querySelector('#status'),
  topicFilter: document.querySelector('#topicFilter'),
  shuffleButton: document.querySelector('#shuffleButton'),
  resetButton: document.querySelector('#resetButton'),
  progressText: document.querySelector('#progressText'),
  cardTopic: document.querySelector('#cardTopic'),
  cardNumber: document.querySelector('#cardNumber'),
  cardDue: document.querySelector('#cardDue'),
  cardQuestion: document.querySelector('#cardQuestion'),
  answerPanel: document.querySelector('#answerPanel'),
  cardAnswer: document.querySelector('#cardAnswer'),
  showAnswerButton: document.querySelector('#showAnswerButton'),
  ratingPanel: document.querySelector('#ratingPanel'),
  progressBar: document.querySelector('#progressBar'),
  finishText: document.querySelector('#finishText'),
};

async function loadCards() {
  setStatus('Загрузка карточек…');
  loadProgress();
  try {
    const response = await fetch('cards.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.allCards = normalizeCards(Array.isArray(data) ? data : data.cards);
    if (state.allCards.length === 0) throw new Error('Файл cards.json не содержит карточек');
    populateTopics(state.allCards);
    applyFilter();
    enableControls(true);
    setStatus(`Загружено карточек: ${state.allCards.length}. Слабые карточки будут возвращаться чаще.`);
  } catch (error) {
    console.error(error);
    setStatus('Не удалось загрузить cards.json. Открой сайт через локальный сервер: python3 -m http.server 8000', true);
  }
}

function normalizeCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .map((card, index) => ({
      id: String(card.id ?? `card-${index + 1}`),
      topic: String(card.topic || card.category || 'Общее').trim(),
      question: String(card.question || '').trim(),
      answer: String(card.answer || '').trim(),
      frequency: Number(card.frequency || 1),
      term: String(card.term || '').trim(),
    }))
    .filter(card => card.question && card.answer);
}

function populateTopics(cards) {
  const topics = [...new Set(cards.map(card => card.topic))].sort((a, b) => a.localeCompare(b, 'ru'));
  els.topicFilter.innerHTML = '<option value="all">Все темы</option>';
  for (const topic of topics) {
    const option = document.createElement('option');
    option.value = topic;
    option.textContent = topic;
    els.topicFilter.append(option);
  }
}

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state.progress = saved.progress && typeof saved.progress === 'object' ? saved.progress : {};
    state.todayReviewed = saved.reviewDate === todayKey() ? Number(saved.todayReviewed || 0) : 0;
  } catch {
    state.progress = {};
    state.todayReviewed = 0;
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: 1,
    reviewDate: todayKey(),
    todayReviewed: state.todayReviewed,
    progress: state.progress,
  }));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function progressFor(cardId) {
  if (!state.progress[cardId]) {
    state.progress[cardId] = {
      reps: 0,
      lapses: 0,
      intervalDays: 0,
      ease: 2.3,
      dueAt: 0,
      lastRating: null,
      lastReviewedAt: null,
    };
  }
  return state.progress[cardId];
}

function applyFilter() {
  const selectedTopic = els.topicFilter.value;
  state.cards = selectedTopic === 'all'
    ? [...state.allCards]
    : state.allCards.filter(card => card.topic === selectedTopic);
  rebuildQueue();
  drawNextCard();
}

function rebuildQueue() {
  const now = Date.now();
  state.queue = state.cards
    .map(card => ({ card, score: schedulingScore(card, now) }))
    .sort((a, b) => b.score - a.score || a.card.question.localeCompare(b.card.question, 'ru'))
    .map(item => item.card);
}

function schedulingScore(card, now) {
  const progress = progressFor(card.id);
  const dueAt = Number(progress.dueAt || 0);
  const overdueDays = Math.max(0, (now - dueAt) / MS_PER_DAY);
  const newBonus = progress.reps ? 0 : 1000;
  const lapseBonus = Number(progress.lapses || 0) * 80;
  const frequencyBonus = Math.min(Number(card.frequency || 1), 10) * 2;
  const dueBonus = dueAt <= now ? 500 + overdueDays * 50 : -Math.min((dueAt - now) / MS_PER_DAY, 365);
  return newBonus + lapseBonus + frequencyBonus + dueBonus - Number(progress.intervalDays || 0);
}

function drawNextCard() {
  state.answerVisible = false;
  if (state.queue.length === 0 && state.cards.length > 0) rebuildQueue();
  state.currentCard = state.queue.shift() || null;
  render();
}

function render() {
  const total = state.cards.length;
  const card = state.currentCard;
  updateStudyStats();
  if (!card) {
    els.cardTopic.textContent = 'Нет карточек';
    els.cardNumber.textContent = '0 / 0';
    els.cardDue.textContent = '—';
    els.cardQuestion.textContent = total ? 'На сейчас карточек нет.' : 'Карточки не найдены.';
    els.cardAnswer.textContent = '—';
    els.answerPanel.hidden = true;
    els.ratingPanel.hidden = true;
    els.showAnswerButton.disabled = true;
    els.finishText.textContent = total ? 'Все карточки в выбранной теме запланированы на будущее. Можно сменить тему или сбросить прогресс.' : '';
    return;
  }

  const position = total - state.queue.length;
  const progress = progressFor(card.id);
  els.cardTopic.textContent = card.topic;
  els.cardNumber.textContent = `Карточка ${position} / ${total}`;
  els.cardDue.textContent = dueLabel(progress);
  els.cardQuestion.textContent = card.question;
  els.cardAnswer.textContent = card.answer;
  els.answerPanel.hidden = !state.answerVisible;
  els.ratingPanel.hidden = !state.answerVisible;
  els.showAnswerButton.disabled = state.answerVisible;
  els.finishText.textContent = `Интервал: ${progress.intervalDays || 0} дн. · Повторов: ${progress.reps || 0} · Ошибок: ${progress.lapses || 0}`;
}

function updateStudyStats() {
  const total = state.cards.length || 1;
  const reviewedInDeck = state.cards.filter(card => progressFor(card.id).reps > 0).length;
  const percent = Math.round((reviewedInDeck / total) * 100);
  els.progressText.textContent = `${state.todayReviewed} / ${state.cards.length}`;
  els.progressBar.style.width = `${percent}%`;
}

function dueLabel(progress) {
  if (!progress.reps) return 'Новая';
  const dueAt = Number(progress.dueAt || 0);
  const diff = dueAt - Date.now();
  if (diff <= 0) return 'Пора повторить';
  if (diff < MS_PER_DAY) return 'Сегодня позже';
  const days = Math.ceil(diff / MS_PER_DAY);
  return `Через ${days} дн.`;
}

function revealAnswer() {
  if (!state.currentCard) return;
  state.answerVisible = true;
  render();
}

function rateCurrentCard(rating) {
  if (!state.currentCard) return;
  const card = state.currentCard;
  const progress = progressFor(card.id);
  const now = Date.now();
  progress.reps = Number(progress.reps || 0) + 1;
  progress.lastRating = rating;
  progress.lastReviewedAt = new Date(now).toISOString();

  if (rating === 'again') {
    progress.lapses = Number(progress.lapses || 0) + 1;
    progress.ease = Math.max(1.3, Number(progress.ease || 2.3) - 0.25);
    progress.intervalDays = 0;
    progress.dueAt = now + AGAIN_DELAY_MS;
    reinsertSoon(card, 2);
  } else if (rating === 'hard') {
    progress.ease = Math.max(1.3, Number(progress.ease || 2.3) - 0.1);
    progress.intervalDays = progress.intervalDays ? Math.max(1, Math.ceil(progress.intervalDays * 1.2)) : 1;
    progress.dueAt = now + progress.intervalDays * MS_PER_DAY;
    reinsertSoon(card, 8);
  } else if (rating === 'easy') {
    progress.ease = Math.min(3.0, Number(progress.ease || 2.3) + 0.15);
    progress.intervalDays = progress.intervalDays ? Math.ceil(progress.intervalDays * progress.ease) : 3;
    progress.dueAt = now + progress.intervalDays * MS_PER_DAY;
  }

  state.todayReviewed += 1;
  saveProgress();
  drawNextCard();
}

function reinsertSoon(card, afterCards) {
  const existingIndex = state.queue.findIndex(item => item.id === card.id);
  if (existingIndex !== -1) state.queue.splice(existingIndex, 1);
  const index = Math.min(afterCards, state.queue.length);
  state.queue.splice(index, 0, card);
}

function shuffleQueue() {
  for (let i = state.queue.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  setStatus('Очередь перемешана. Расписание повторений сохранено.');
  render();
}

function resetProgress() {
  if (!confirm('Сбросить весь прогресс и расписание повторений для этого сайта?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state.progress = {};
  state.todayReviewed = 0;
  rebuildQueue();
  drawNextCard();
  saveProgress();
  setStatus('Прогресс сброшен. Все карточки снова новые.');
}

function enableControls(enabled) {
  els.topicFilter.disabled = !enabled;
  els.shuffleButton.disabled = !enabled;
  els.resetButton.disabled = !enabled;
  els.showAnswerButton.disabled = !enabled;
}

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('error', isError);
}

els.showAnswerButton.addEventListener('click', revealAnswer);
els.ratingPanel.addEventListener('click', event => {
  const button = event.target.closest('[data-rating]');
  if (button) rateCurrentCard(button.dataset.rating);
});
els.topicFilter.addEventListener('change', applyFilter);
els.shuffleButton.addEventListener('click', shuffleQueue);
els.resetButton.addEventListener('click', resetProgress);

document.addEventListener('keydown', event => {
  if (event.key === ' ' || event.key === 'Enter') {
    if (!state.answerVisible) {
      event.preventDefault();
      revealAnswer();
    }
  }
  if (state.answerVisible && ['1', '2', '3'].includes(event.key)) {
    event.preventDefault();
    rateCurrentCard({ '1': 'again', '2': 'hard', '3': 'easy' }[event.key]);
  }
});

loadCards();

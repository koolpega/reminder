(() => {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  const dateSelect = document.getElementById('date-select');
  const rangeSelect = document.getElementById('range-select');
  const rangeHint = document.getElementById('range-hint');
  const startTime = document.getElementById('start-time');
  const endTime = document.getElementById('end-time');
  const durationHint = document.getElementById('duration-hint');
  const bookForm = document.getElementById('book-form');
  const bookSubmit = document.getElementById('book-submit');
  const bookMessage = document.getElementById('book-message');

  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  const bookedList = document.getElementById('booked-list');

  const reminderForm = document.getElementById('reminder-form');
  const reminderStatus = document.getElementById('reminder-message-status');

  // Given an IST calendar date "YYYY-MM-DD" and an hour (0-24) on that date, return the true UTC epoch ms of that IST wall-clock moment.
  function istHourToUtcMs(dateStr, hour) {
    const [y, m, d] = dateStr.split('-').map(Number);
    let h = hour;
    let extraDayMs = 0;
    if (h === 24) { h = 0; extraDayMs = 24 * 60 * 60 * 1000; }
    return Date.UTC(y, m - 1, d, h, 0, 0) - IST_OFFSET_MS + extraDayMs;
  }

  function localTimeStr(ms) {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function localDateStr(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function localLabel(ms) {
    return new Date(ms).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // Combine the currently selected date with a "HH:MM" local time value into a real Date object. If `time` is "00:00" and is earlier than or equal to `afterMs`, treat it as rolling into the next day.
  function localTimeToDate(dateStr, time, rollIfBeforeMs) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [h, min] = time.split(':').map(Number);
    let dt = new Date(y, m - 1, d, h, min, 0, 0);
    if (rollIfBeforeMs !== undefined && dt.getTime() <= rollIfBeforeMs) {
      dt = new Date(dt.getTime() + 24 * 60 * 60 * 1000);
    }
    return dt;
  }

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (!data.status) {
        statusDot.className = 'status-dot warn';
        statusText.textContent = 'status unavailable';
        return;
      }
      statusText.textContent = data.status;
      if (data.status === 'AVAILABLE') statusDot.className = 'status-dot good';
      else if (['SLEEPING', 'BUSY', 'UNAVAILABLE', 'EXAM'].includes(data.status)) statusDot.className = 'status-dot bad';
      else statusDot.className = 'status-dot warn';
    } catch (e) {
      statusDot.className = 'status-dot warn';
      statusText.textContent = 'status unavailable';
    }
  }

  let currentSlots = [];

  async function loadDates() {
    try {
      const res = await fetch('/api/dates');
      const data = await res.json();
      dateSelect.innerHTML = '';
      if (!data.dates || data.dates.length === 0) {
        dateSelect.innerHTML = '<option value="" disabled selected>No open dates right now</option>';
        return;
      }
      dateSelect.innerHTML = '<option value="" disabled selected>Choose a date</option>' +
        data.dates.map(d => `<option value="${d}">${d}</option>`).join('');
    } catch (e) {
      dateSelect.innerHTML = '<option value="" disabled selected>Couldn\'t load dates</option>';
    }
  }

  async function loadSlots(date) {
    rangeSelect.disabled = true;
    rangeSelect.innerHTML = '<option value="" disabled selected>Loading&hellip;</option>';
    resetTimeInputs();
    try {
      const res = await fetch(`/api/slots/${encodeURIComponent(date)}`);
      const data = await res.json();
      currentSlots = data.slots || [];
      if (currentSlots.length === 0) {
        rangeSelect.innerHTML = '<option value="" disabled selected>No open windows on this date</option>';
        return;
      }
      rangeSelect.innerHTML = '<option value="" disabled selected>Choose a window</option>' +
        currentSlots.map((s, i) => {
          const utcStart = istHourToUtcMs(date, s.start);
          const utcEnd = istHourToUtcMs(date, s.end);
          return `<option value="${i}">${s.label} &middot; local ${localLabel(utcStart)}&ndash;${localLabel(utcEnd)}</option>`;
        }).join('');
      rangeSelect.disabled = false;
    } catch (e) {
      rangeSelect.innerHTML = '<option value="" disabled selected>Couldn\'t load windows</option>';
    }
  }

  function resetTimeInputs() {
    startTime.value = '';
    endTime.value = '';
    startTime.disabled = true;
    endTime.disabled = true;
    startTime.removeAttribute('min');
    startTime.removeAttribute('max');
    endTime.removeAttribute('min');
    endTime.removeAttribute('max');
    rangeHint.textContent = '';
    updateSubmitState();
  }

  function onRangeChosen() {
    const idx = Number(rangeSelect.value);
    const slot = currentSlots[idx];
    if (!slot) return;

    const date = dateSelect.value;
    const utcStart = istHourToUtcMs(date, slot.start);
    const utcEnd = istHourToUtcMs(date, slot.end);

    const sameLocalDay = localDateStr(utcStart) === localDateStr(utcEnd) || localTimeStr(utcEnd) === '00:00';

    startTime.disabled = false;
    endTime.disabled = false;
    startTime.min = localTimeStr(utcStart);
    endTime.min = localTimeStr(utcStart);
    if (sameLocalDay && localTimeStr(utcEnd) !== '00:00') {
      startTime.max = localTimeStr(utcEnd);
      endTime.max = localTimeStr(utcEnd);
    } else {
      startTime.removeAttribute('max');
      endTime.removeAttribute('max');
    }

    startTime.value = startTime.min;
    const defaultEndMs = Math.min(utcStart + 60 * 60 * 1000, utcEnd);
    endTime.value = localTimeStr(defaultEndMs);

    rangeHint.textContent = `Window in your local time: ${localLabel(utcStart)} – ${localLabel(utcEnd)}.`;
    updateSubmitState();
  }

  function currentDuration() {
    const date = dateSelect.value;
    if (!date || !startTime.value || !endTime.value) return null;
    const startDt = localTimeToDate(date, startTime.value);
    const endDt = localTimeToDate(date, endTime.value, startDt.getTime());
    return { startDt, endDt, hours: (endDt.getTime() - startDt.getTime()) / 3_600_000 };
  }

  function updateSubmitState() {
    const info = currentDuration();
    const name = document.getElementById('book-name').value.trim();
    const reason = document.getElementById('book-reason').value.trim();
    let ok = true;

    if (!info || info.hours <= 0 || info.hours > 1) {
      durationHint.textContent = info && info.hours > 1
        ? 'Max slot length is 1 hour. Adjust the end time.'
        : 'Max slot length: 1 hour.';
      durationHint.style.color = info && info.hours > 1 ? 'var(--bad)' : 'var(--muted)';
      ok = false;
    } else {
      durationHint.textContent = `Booking length: ${Math.round(info.hours * 60)} minutes.`;
      durationHint.style.color = 'var(--muted)';
    }

    if (!name || !reason || startTime.disabled || !startTime.value || !endTime.value) ok = false;
    bookSubmit.disabled = !ok;
  }

  dateSelect.addEventListener('change', () => loadSlots(dateSelect.value));
  rangeSelect.addEventListener('change', onRangeChosen);
  startTime.addEventListener('change', updateSubmitState);
  endTime.addEventListener('change', updateSubmitState);
  document.getElementById('book-name').addEventListener('input', updateSubmitState);
  document.getElementById('book-reason').addEventListener('input', updateSubmitState);

  bookForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const info = currentDuration();
    if (!info || info.hours <= 0 || info.hours > 1) return;

    bookSubmit.disabled = true;
    bookMessage.textContent = 'Booking…';
    bookMessage.className = 'form-message';

    try {
      const res = await fetch('/api/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_ms: info.startDt.getTime(),
          end_ms: info.endDt.getTime(),
          name: document.getElementById('book-name').value.trim(),
          reason: document.getElementById('book-reason').value.trim(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        bookMessage.textContent = 'Slot booked.';
        bookMessage.className = 'form-message ok';
        bookForm.reset();
        resetTimeInputs();
        await loadDates();
        await loadBookedSlots();
      } else {
        bookMessage.textContent = data.message || 'Could not book that slot.';
        bookMessage.className = 'form-message err';
      }
    } catch (e) {
      bookMessage.textContent = 'Network error. Try again.';
      bookMessage.className = 'form-message err';
    } finally {
      updateSubmitState();
    }
  });

  async function loadBookedSlots() {
    try {
      const res = await fetch('/api/booked_slots');
      const data = await res.json();
      const slots = data.slots || [];
      if (slots.length === 0) {
        bookedList.innerHTML = '<li class="slot-empty">No slots booked yet.</li>';
        return;
      }
      bookedList.innerHTML = slots.map(s => `
        <li class="slot-item">
          <div class="slot-time">${s.label}</div>
          <div class="slot-name">${escapeHtml(s.name)}</div>
          <div class="slot-reason">${escapeHtml(s.reason)}</div>
        </li>
      `).join('');
    } catch (e) {
      bookedList.innerHTML = '<li class="slot-empty">Couldn\'t load booked slots.</li>';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  reminderForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reminder-name').value.trim();
    const message = document.getElementById('reminder-message').value.trim();
    if (!name || !message) return;

    reminderStatus.textContent = 'Sending…';
    reminderStatus.className = 'form-message';

    try {
      const res = await fetch('/api/reminder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, message }),
      });
      const data = await res.json();
      if (data.ok) {
        reminderStatus.textContent = 'Sent.';
        reminderStatus.className = 'form-message ok';
        reminderForm.reset();
      } else {
        reminderStatus.textContent = data.message || 'Could not send that.';
        reminderStatus.className = 'form-message err';
      }
    } catch (e) {
      reminderStatus.textContent = 'Network error. Try again.';
      reminderStatus.className = 'form-message err';
    }
  });

  loadStatus();
  loadDates();
  loadBookedSlots();
  setInterval(loadStatus, 30_000);
  setInterval(loadBookedSlots, 20_000);
})();
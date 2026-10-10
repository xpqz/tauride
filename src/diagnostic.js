// Text controls shared by the About dialog and protocol log.
(function () {
  function createDiagnosticText(root, close) {
    const field = root.querySelector('textarea[readonly]');
    const copyButton = root.querySelector('[data-diagnostic=copy]');
    const copyAllButton = root.querySelector('[data-diagnostic=copy-all]');
    const findButton = root.querySelector('[data-diagnostic=find]');
    const findBar = root.querySelector('[data-diagnostic=find-bar]');
    const query = root.querySelector('input[type=search]');
    const count = root.querySelector('[data-diagnostic=count]');
    const nextButton = root.querySelector('[data-diagnostic=next]');
    const previousButton = root.querySelector('[data-diagnostic=previous]');
    const matches = [];
    let current = -1;

    const updateCopy = () => { copyButton.disabled = field.selectionStart === field.selectionEnd; };
    const updateCount = () => {
      count.textContent = query.value ? (matches.length ? `${current + 1} of ${matches.length}` : 'No matches') : '';
    };
    const scan = () => {
      matches.length = 0;
      if (!query.value) return;
      const escaped = query.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of field.value.matchAll(new RegExp(escaped, 'gi'))) {
        matches.push({ start: match.index, end: match.index + match[0].length });
      }
    };
    const reveal = (match) => {
      const style = getComputedStyle(field);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      const before = field.value.slice(0, match.start);
      const line = before.split('\n').length - 1;
      const top = (parseFloat(style.paddingTop) || 0) + line * lineHeight;
      if (top < field.scrollTop) field.scrollTop = top;
      else if (top + lineHeight > field.scrollTop + field.clientHeight) {
        field.scrollTop = top + lineHeight - field.clientHeight;
      }
      const column = before.slice(before.lastIndexOf('\n') + 1);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = style.font || `${style.fontSize} ${style.fontFamily}`;
      const left = (parseFloat(style.paddingLeft) || 0) + context.measureText(column).width;
      const width = context.measureText(field.value.slice(match.start, match.end).split('\n')[0]).width;
      if (left < field.scrollLeft) field.scrollLeft = left;
      else if (left + width > field.scrollLeft + field.clientWidth) {
        field.scrollLeft = left + width - field.clientWidth;
      }
    };
    const selectMatch = (index) => {
      if (!matches.length) return;
      current = (index + matches.length) % matches.length;
      field.setSelectionRange(matches[current].start, matches[current].end);
      reveal(matches[current]);
      query.focus();
      updateCopy();
      updateCount();
    };
    const search = () => {
      query.focus();
      current = -1;
      scan();
      if (matches.length) selectMatch(0);
      else {
        field.setSelectionRange(field.selectionEnd, field.selectionEnd);
        updateCopy();
        updateCount();
      }
    };
    const find = () => { findBar.hidden = false; root.classList.add('diagnostic-searching'); query.focus(); query.select(); };
    const hideFind = () => { findBar.hidden = true; root.classList.remove('diagnostic-searching'); field.focus(); };
    const copy = (all) => {
      const start = field.selectionStart;
      const end = field.selectionEnd;
      if (!all && start === end) return;
      const top = field.scrollTop;
      const left = field.scrollLeft;
      field.focus();
      if (all) field.select();
      document.execCommand('copy');
      if (all) field.setSelectionRange(start, end);
      field.scrollTop = top;
      field.scrollLeft = left;
      updateCopy();
    };
    const append = (chunk) => {
      const start = field.selectionStart;
      const end = field.selectionEnd;
      const top = field.scrollTop;
      const left = field.scrollLeft;
      const follow = field.scrollHeight - field.clientHeight - top < 3
        && start === end && findBar.hidden;
      field.setRangeText(chunk, field.value.length, field.value.length, 'preserve');
      field.setSelectionRange(start, end);
      if (query.value) {
        const old = matches[current];
        scan();
        current = old === undefined ? -1 : matches.findIndex((match) => match.start === old.start);
        updateCount();
      }
      field.scrollTop = follow ? field.scrollHeight : top;
      field.scrollLeft = left;
      updateCopy();
    };

    copyButton.onclick = () => copy(false);
    copyAllButton.onclick = () => copy(true);
    findButton.onclick = find;
    nextButton.onclick = () => selectMatch(current + 1);
    previousButton.onclick = () => selectMatch(current < 0 ? matches.length - 1 : current - 1);
    query.oninput = search;
    query.onkeydown = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) previousButton.click(); else nextButton.click();
      }
    };
    field.addEventListener('select', updateCopy);
    field.addEventListener('keyup', updateCopy);
    field.addEventListener('mouseup', updateCopy);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!findBar.hidden) hideFind(); else if (close) close();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        find();
      }
    });
    if (window.__TAURI__) {
      window.__TAURI__.webviewWindow.getCurrentWebviewWindow().listen('ride-diagnostic-menu', ({ payload }) => {
        if (payload === 'SC') find();
        else if (payload === 'SA') {
          (document.activeElement === query ? query : field).select();
          updateCopy();
        }
      });
    }
    updateCopy();
    if (document.activeElement === document.body) field.focus();
    return {
      append,
      find,
      copyAll: () => copy(true),
      setText(text) {
        field.value = text;
        field.setSelectionRange(0, 0);
        field.scrollTop = 0;
        query.value = '';
        matches.length = 0;
        current = -1;
        count.textContent = '';
        findBar.hidden = true;
        root.classList.remove('diagnostic-searching');
        updateCopy();
        field.focus();
      },
      selectAll: () => {
        if (document.activeElement === query) query.select();
        else { field.focus(); field.select(); updateCopy(); }
      },
    };
  }
  window.createDiagnosticText = createDiagnosticText;
}());

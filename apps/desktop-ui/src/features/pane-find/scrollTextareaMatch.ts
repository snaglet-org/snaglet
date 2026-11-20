/** Measure the textarea's wrapped layout without changing focus or the draft. */
export function scrollTextareaMatch(area: HTMLTextAreaElement, offset: number): void {
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const property of [
    'font',
    'line-height',
    'letter-spacing',
    'padding',
    'border',
    'box-sizing',
    'tab-size',
    'word-spacing',
  ]) {
    mirror.style.setProperty(property, style.getPropertyValue(property));
  }
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    visibility: 'hidden',
    width: `${area.clientWidth}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  mirror.textContent = area.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = area.value.slice(offset, offset + 1) || '\u200b';
  mirror.append(marker, document.createTextNode(area.value.slice(offset + 1)));
  document.body.append(mirror);
  area.scrollTop = Math.max(0, marker.offsetTop - area.clientHeight / 2);
  mirror.remove();
}

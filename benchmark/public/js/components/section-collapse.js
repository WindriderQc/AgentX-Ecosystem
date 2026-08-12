// section-collapse.js
// IMPORTANT: Call initSectionCollapse() only after all section HTML has been rendered.
export function initSectionCollapse(container = document) {
  container.querySelectorAll('.r-sec-head').forEach(head => {
    const toggle = head.querySelector('.r-sec-toggle');
    const body = head.nextElementSibling;
    if (!toggle || !body) return;

    head.style.cursor = 'pointer';
    head.addEventListener('click', () => {
      const isCollapsed = body.classList.toggle('collapsed');
      toggle.textContent = isCollapsed ? '▶' : '▼';
    });
  });
}

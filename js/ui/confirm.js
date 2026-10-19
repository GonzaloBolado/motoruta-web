// Confirmación con la estética de la app (en vez del confirm() del navegador).

/**
 * @returns Promise<boolean>
 * @param opts {title, okText, cancelText, danger}
 */
export function confirmDialog(message, { title = '', okText = 'Aceptar', cancelText = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm';
    dialog.innerHTML = `
      ${title ? '<h3></h3>' : ''}
      <p></p>
      <footer>
        <button type="button" data-v="0"></button>
        <button type="button" data-v="1" class="${danger ? 'danger' : 'primary'}"></button>
      </footer>`;
    if (title) dialog.querySelector('h3').textContent = title;
    dialog.querySelector('p').textContent = message;
    dialog.querySelector('[data-v="0"]').textContent = cancelText;
    dialog.querySelector('[data-v="1"]').textContent = okText;

    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => finish(b.dataset.v === '1')));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    // clic fuera del cuadro = cancelar
    dialog.addEventListener('mousedown', (e) => {
      if (e.target === dialog) finish(false);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    dialog.querySelector('[data-v="1"]').focus();
  });
}

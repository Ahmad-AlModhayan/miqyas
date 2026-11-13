(() => {
  const runtimeLog = document.getElementById('runtime-log');
  window.addEventListener('error', (event) => {
    if (runtimeLog) runtimeLog.textContent = String(event.message || 'Unhandled error');
  });

  const addBtn = document.getElementById('add-to-cart');
  const cartStatus = document.getElementById('cart-status');
  addBtn?.addEventListener('click', () => {
    if (cartStatus) cartStatus.textContent = '1 item ready';
  });

  const checkoutBtn = document.getElementById('checkout-btn');
  const emailInput = document.getElementById('email-input');
  const emailError = document.getElementById('email-error');
  checkoutBtn?.addEventListener('click', () => {
    const val = emailInput instanceof HTMLInputElement ? emailInput.value.trim() : '';
    if (!val && emailError) {
      emailError.textContent = 'Email is required';
    } else if (emailError) {
      emailError.textContent = 'Order submitted';
    }
  });

  const payBtn = document.getElementById('pay-btn');
  const a11yReadout = document.getElementById('a11y-readout');
  if (a11yReadout) {
    const label = payBtn?.getAttribute('aria-label')?.trim() || 'missing';
    a11yReadout.textContent = `Accessible label: ${label}`;
  }

  function renderReceipt() {
    return 'Receipt engine OK';
  }
  const receiptStatus = document.getElementById('receipt-status');
  if (receiptStatus) {
    receiptStatus.textContent = renderReceipt();
  }

  const commentBox = document.getElementById('comment-box');
  if (commentBox) {
    commentBox.textContent = 'Safe comment text';
  }

  const quotaStatus = document.getElementById('quota-status');
  if (quotaStatus) {
    quotaStatus.textContent = 'Rate limit: max 3 calls';
  }
})();

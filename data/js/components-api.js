// API Reference page enhancements
// Adds copy-to-clipboard buttons for code blocks and simple filtering (future ready)
(function(){
  function enhanceCodeBlocks(){
    document.querySelectorAll('#api pre.code').forEach(pre => {
      if (pre.dataset.enhanced) return;
      pre.dataset.enhanced = '1';
      const btn = document.createElement('button');
      btn.textContent = 'Copy';
      btn.className = 'btn sm';
      btn.style.position = 'absolute';
      btn.style.top = '6px';
      btn.style.right = '6px';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(pre.textContent.trim()).then(()=>{
          btn.textContent = 'Copied';
          setTimeout(()=>btn.textContent='Copy', 1500);
        });
      });
      const wrap = document.createElement('div');
      wrap.style.position = 'relative';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      wrap.appendChild(btn);
    });
  }

  document.addEventListener('DOMContentLoaded', enhanceCodeBlocks);
  // In case component is loaded dynamically via AJAX in future
  window.addEventListener('api:view', enhanceCodeBlocks);
})();

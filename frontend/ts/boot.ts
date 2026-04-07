window.onerror = function(msg, src, line, col, err) {
    document.title = 'ERR:' + line + ':' + msg;
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:red;color:white;padding:10px;font-size:12px;white-space:pre-wrap;';
    d.textContent = 'JS Error at line ' + line + ':\n' + msg + '\n' + (err ? err.stack : '');
    document.body ? document.body.prepend(d) : document.addEventListener('DOMContentLoaded', function(){ document.body.prepend(d); });
  };
  window.addEventListener('unhandledrejection', function(e) {
    document.title = 'REJECT:' + e.reason;
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:orange;color:black;padding:10px;font-size:12px;white-space:pre-wrap;';
    d.textContent = 'Unhandled rejection:\n' + e.reason;
    document.body ? document.body.prepend(d) : document.addEventListener('DOMContentLoaded', function(){ document.body.prepend(d); });
  });

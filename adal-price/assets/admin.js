(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var status = $('status');

  function say(text, kind) {
    status.textContent = text || '';
    status.className = 'admin__status' + (kind ? ' admin__status--' + kind : '');
  }

  function api(path, options) {
    options = options || {};
    options.credentials = 'same-origin';
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'Сервер не ответил' }; }).then(function (data) {
        if (!res.ok || !data.ok) {
          var err = new Error(data.error || 'Ошибка ' + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function show(view) {
    $('login-view').hidden = view !== 'login';
    $('app-view').hidden = view !== 'app';
    $('logout').hidden = view !== 'app';
  }

  function onError(err) {
    if (err.status === 401 && !$('app-view').hidden) {
      show('login');
      say('Сессия закончилась — войдите снова.', 'error');
    } else {
      say(err.message, 'error');
    }
  }

  /* List of published letters */
  function render(letters) {
    var list = $('list');
    list.textContent = '';
    $('empty').hidden = letters.length > 0;
    letters.forEach(function (letter) {
      var item = document.createElement('li');
      item.className = 'admin__item';

      var thumb = document.createElement('img');
      thumb.src = '/letters/' + letter.id + '/thumb.jpg';
      thumb.alt = '';
      thumb.width = 64;
      thumb.height = 84;

      var text = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = letter.title;
      var info = document.createElement('span');
      var pages = letter.pages.length;
      info.textContent = [letter.date, pages > 1 ? pages + ' стр.' : ''].filter(Boolean).join(' · ');
      text.append(title, info);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn--ghost btn--sm';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', function () {
        if (!window.confirm('Удалить с сайта письмо «' + letter.title + '»?')) return;
        remove.disabled = true;
        api('/api/letters/' + letter.id, { method: 'DELETE' })
          .then(function (data) { render(data.letters); say('Письмо удалено.', 'ok'); })
          .catch(function (err) { remove.disabled = false; onError(err); });
      });

      item.append(thumb, text, remove);
      list.appendChild(item);
    });
  }

  function loadLetters() {
    return api('/api/letters', { cache: 'no-store' }).then(function (data) { render(data.letters); });
  }

  /* Every letter goes to the site as JPEG pages: a photo becomes one page, and each page of a PDF
     is drawn with PDF.js right here in the browser, so visitors read the letter without opening a PDF. */
  var PDFJS = '/assets/vendor/pdfjs-4.10.38/';
  var MAX_PAGES = 10;
  var MAX_PDF = 50 * 1024 * 1024;
  var MAX_UPLOAD = 9.5 * 1024 * 1024; // the server takes up to 10 MB per letter

  function canvasJpeg(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve({ blob: blob, w: canvas.width, h: canvas.height });
        else reject(new Error('Не удалось обработать файл'));
      }, 'image/jpeg', quality);
    });
  }

  function toJpeg(source, maxSide, quality) {
    var width = source.naturalWidth || source.width;
    var height = source.naturalHeight || source.height;
    var scale = Math.min(1, maxSide / Math.max(width, height));
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvasJpeg(canvas, quality);
  }

  function openImage(file) {
    var viaImg = function () {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = function () { reject(new Error('Не удалось открыть фото. Сохраните его как JPG и попробуйте снова.')); };
        img.src = URL.createObjectURL(file);
      });
    };
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(viaImg);
    }
    return viaImg();
  }

  function photoPages(file) {
    return openImage(file).then(function (image) {
      return Promise.all([toJpeg(image, 2000, 0.85), toJpeg(image, 600, 0.8)]);
    }).then(function (out) {
      return { pages: [out[0]], thumb: out[1], total: 1 };
    });
  }

  var pdfjs = null;
  function loadPdfjs() {
    if (!pdfjs) {
      pdfjs = import(PDFJS + 'pdf.min.mjs').then(function (lib) {
        lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
        return lib;
      });
      pdfjs.catch(function () { pdfjs = null; }); // try again with the next file
    }
    return pdfjs;
  }

  function pdfError(err) {
    var name = err && err.name;
    if (name === 'PasswordException') return 'PDF защищён паролем. Откройте его, сохраните копию без пароля и загрузите её.';
    if (name === 'InvalidPDFException') return 'Файл повреждён или это не PDF. Сохраните письмо в PDF заново или загрузите фото.';
    return 'Не удалось прочитать PDF. Сохраните письмо в PDF заново или загрузите фото.';
  }

  function pdfPages(file) {
    return loadPdfjs().catch(function () {
      throw new Error('Не удалось загрузить модуль для PDF — проверьте интернет и попробуйте ещё раз.');
    }).then(function (lib) {
      return file.arrayBuffer().then(function (buf) {
        return lib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
      }).then(function (doc) {
        var count = Math.min(doc.numPages, MAX_PAGES);
        var side = count > 3 ? 1600 : 2000; // more pages, smaller pictures: the letter stays under 10 MB
        var out = { pages: [], total: doc.numPages };
        var drawPage = function (n) {
          if (n > count) return out;
          return doc.getPage(n).then(function (page) {
            var base = page.getViewport({ scale: 1 });
            var viewport = page.getViewport({ scale: side / Math.max(base.width, base.height) });
            var canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
              return Promise.all([canvasJpeg(canvas, 0.85), n === 1 ? toJpeg(canvas, 600, 0.8) : null]);
            }).then(function (jpegs) {
              out.pages.push(jpegs[0]);
              if (jpegs[1]) out.thumb = jpegs[1];
              page.cleanup();
              canvas.width = canvas.height = 0; // free the memory at once: phones run out of it quickly
              return drawPage(n + 1);
            });
          });
        };
        return Promise.resolve(drawPage(1)).then(function (res) { doc.destroy(); return res; }, function (err) { doc.destroy(); throw err; });
      }).catch(function (err) {
        throw new Error(pdfError(err));
      });
    });
  }

  var isPdf = function (file) { return file.type === 'application/pdf' || /\.pdf$/i.test(file.name); };
  var prepared = null;

  // one file is processed once: the preview and the upload use the same pages
  function prepare(file) {
    if (!prepared || prepared.file !== file) {
      var result = isPdf(file)
        ? (file.size > MAX_PDF ? Promise.reject(new Error('PDF больше 50 МБ — сохраните его с меньшим качеством или загрузите фото.')) : pdfPages(file))
        : photoPages(file);
      prepared = { file: file, result: result };
      result.catch(function () { if (prepared && prepared.result === result) prepared = null; }); // next try reads the file again
    }
    return prepared.result;
  }

  var fileInput = $('upload-form').elements.file;
  var preview = $('preview');
  var note = $('file-note');

  function clearPreview() {
    if (preview.src.indexOf('blob:') === 0) URL.revokeObjectURL(preview.src);
    preview.hidden = true;
    note.hidden = true;
    note.className = 'admin__note';
  }

  function pagesNote(res, pdf) {
    if (!pdf) return 'Так письмо будет выглядеть на сайте.';
    if (res.total > res.pages.length) return 'В PDF ' + res.total + ' стр. — на сайт попадут первые ' + res.pages.length + '.';
    if (res.total > 1) return 'PDF превращён в ' + res.total + ' стр. — на сайте они листаются стрелками.';
    return 'PDF превращён в изображение — так письмо будет выглядеть на сайте.';
  }

  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    clearPreview();
    if (!file) return;
    note.textContent = isPdf(file) ? 'Читаем PDF…' : 'Готовим фото…';
    note.hidden = false;
    prepare(file).then(function (res) {
      if (fileInput.files[0] !== file) return; // another file was chosen meanwhile
      preview.src = URL.createObjectURL(res.thumb.blob);
      preview.hidden = false;
      note.textContent = pagesNote(res, isPdf(file));
    }, function (err) {
      if (fileInput.files[0] !== file) return;
      note.textContent = err.message;
      note.className = 'admin__note admin__note--error';
    });
  });

  $('upload-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var file = fileInput.files[0];
    var title = form.elements.title.value.trim();
    if (!file || !title) { say('Выберите файл и укажите, от кого письмо.', 'error'); return; }

    var button = $('upload-btn');
    button.disabled = true;
    say(isPdf(file) ? 'Готовим страницы PDF…' : 'Загружаем письмо…');
    prepare(file)
      .then(function (res) {
        var data = new FormData();
        data.append('title', title);
        data.append('date', form.elements.date.value.trim());
        data.append('sizes', JSON.stringify(res.pages.map(function (p) { return [p.w, p.h]; })));
        data.append('thumb', res.thumb.blob, 'thumb.jpg');
        var size = res.thumb.blob.size;
        res.pages.forEach(function (p, i) {
          data.append('p' + (i + 1), p.blob, 'p' + (i + 1) + '.jpg');
          size += p.blob.size;
        });
        if (size > MAX_UPLOAD) throw new Error('Письмо получилось больше 10 МБ — загрузите PDF с меньшим числом страниц.');
        say('Загружаем письмо…');
        return api('/api/letters', { method: 'POST', body: data });
      })
      .then(function (res) {
        render(res.letters);
        form.reset();
        prepared = null;
        clearPreview();
        say('Готово! Письмо уже на сайте.', 'ok');
      })
      .catch(onError)
      .then(function () { button.disabled = false; });
  });

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var button = form.querySelector('button');
    button.disabled = true;
    say('Проверяем пароль…');
    api('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value })
    })
      .then(function () { form.reset(); say(''); show('app'); return loadLetters(); })
      .catch(onError)
      .then(function () { button.disabled = false; });
  });

  $('password-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    api('/api/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: form.elements.current.value, next: form.elements.next.value })
    })
      .then(function () { form.reset(); say('Пароль изменён. На других устройствах нужно будет войти заново.', 'ok'); })
      .catch(onError);
  });

  $('logout').addEventListener('click', function () {
    api('/api/logout', { method: 'POST' }).catch(function () {}).then(function () { show('login'); say('Вы вышли из кабинета.'); });
  });

  api('/api/session', { cache: 'no-store' })
    .then(function (data) {
      if (data.authenticated) { show('app'); return loadLetters(); }
      show('login');
      if (!data.configured) say('Кабинет ещё не настроен — обратитесь к разработчику сайта.', 'error');
    })
    .catch(function () { show('login'); say('Не удалось связаться с сервером.', 'error'); });
})();

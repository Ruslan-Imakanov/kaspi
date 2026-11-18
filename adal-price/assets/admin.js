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

      var thumb;
      if (letter.kind === 'pdf') {
        thumb = document.createElement('span');
        thumb.className = 'admin__pdf';
        thumb.textContent = 'PDF';
      } else {
        thumb = document.createElement('img');
        thumb.src = '/letters/' + letter.id + '/thumb.jpg';
        thumb.alt = '';
        thumb.width = 64;
        thumb.height = 84;
      }

      var text = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = letter.title;
      var date = document.createElement('span');
      date.textContent = letter.date || '';
      text.append(title, date);

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

  /* Photos are shrunk in the browser: a large JPEG for viewing and a small one for the grid */
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
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve({ blob: blob, w: canvas.width, h: canvas.height });
        else reject(new Error('Не удалось обработать фото'));
      }, 'image/jpeg', quality);
    });
  }

  var isPdf = function (file) { return file.type === 'application/pdf' || /\.pdf$/i.test(file.name); };

  $('upload-form').elements.file.addEventListener('change', function () {
    var file = this.files[0];
    var preview = $('preview');
    if (preview.src.indexOf('blob:') === 0) URL.revokeObjectURL(preview.src);
    if (file && !isPdf(file)) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
  });

  $('upload-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target;
    var file = form.elements.file.files[0];
    var title = form.elements.title.value.trim();
    if (!file || !title) { say('Выберите файл и укажите, от кого письмо.', 'error'); return; }

    var data = new FormData();
    data.append('title', title);
    data.append('date', form.elements.date.value.trim());
    var ready;
    if (isPdf(file)) {
      if (file.size > 10 * 1024 * 1024) { say('PDF больше 10 МБ — сфотографируйте письмо или сожмите файл.', 'error'); return; }
      data.append('kind', 'pdf');
      data.append('pdf', file, 'letter.pdf');
      ready = Promise.resolve();
    } else {
      data.append('kind', 'image');
      ready = openImage(file).then(function (image) {
        return Promise.all([toJpeg(image, 2000, 0.85), toJpeg(image, 600, 0.8)]);
      }).then(function (out) {
        data.append('full', out[0].blob, 'full.jpg');
        data.append('thumb', out[1].blob, 'thumb.jpg');
        data.append('w', out[0].w);
        data.append('h', out[0].h);
      });
    }

    var button = $('upload-btn');
    button.disabled = true;
    say('Загружаем письмо…');
    ready
      .then(function () { return api('/api/letters', { method: 'POST', body: data }); })
      .then(function (res) {
        render(res.letters);
        form.reset();
        $('preview').hidden = true;
        say('Готово! Письмо появится на сайте в течение минуты.', 'ok');
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

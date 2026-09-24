# haruspics

Inline image generation extension for SillyTavern.

## Naistera и NovelAI

Расширение поддерживает Naistera как отдельный тип API. Модели NovelAI
используются через Naistera — отдельный официальный NovelAI endpoint не нужен.

### Настройка

1. Получите токен в Telegram-боте Naistera.
2. Откройте настройки `haruspics` в SillyTavern.
3. В поле **Тип API** выберите **Naistera (включая NovelAI)**.
4. Вставьте токен в поле **API ключ**.
5. Оставьте endpoint `https://naistera.org`, если вы не используете совместимый прокси.
6. Нажмите кнопку обновления рядом с полем модели.
7. Выберите модель Naistera или NovelAI из загруженного списка.

Поддерживаются aspect ratio, preset, negative prompt (если capability модели
его разрешает), режимы отправки описаний персонажей, отдельные флаги аватаров
и асинхронная генерация через polling.

### API и формат запроса

- `GET /api/models` — список доступных моделей и их capabilities;
- `POST /api/generate` — запуск генерации;
- `GET /api/generate/jobs/{job_id}` — проверка асинхронной задачи.

Запросы авторизуются заголовком:

```http
Authorization: Bearer YOUR_NAISTERA_TOKEN
```

Референсы отправляются как `reference_objects` с data URL изображения и
описанием. В ответе поддерживаются `data_url`, URL изображения и base64.

### Теги генерации

Существующий формат тегов не изменён:

```text
[IMG:GEN:{"style":"anime","prompt":"девушка с красными волосами"}]
```

Также поддерживается HTML-формат:

```html
<img data-iig-instruction='{"style":"anime","prompt":"девушка с красными волосами"}' src="[IMG:GEN]">
```

В инструкции можно передать `aspect_ratio`, `preset` и `negative_prompt`:

```text
[IMG:GEN:{"style":"anime","prompt":"девушка с красными волосами","aspect_ratio":"2:3","preset":"default","negative_prompt":"blurry"}]
```

Для моделей NovelAI стиль добавляется в prompt как обычный текст, без обёртки
`[Style: ...]`, как в `sillyimages`.

## Ограничения

- Изображения сохраняются через стандартный SillyTavern `/api/images/upload`.
- Видео-режим Naistera из `sillyimages` не переносился: текущий pipeline
  `haruspics` рассчитан на `<img>` и сохранение изображений.
- Проверка API требует действующего токена Naistera и выполняется кнопкой
  обновления списка моделей.

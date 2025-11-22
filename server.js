// Node.js сервер с Playwright для Render
import express from 'express';
import playwright from 'playwright';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// PORT из переменной окружения Render (или 3000 для локальной разработки)
const port = process.env.PORT || 3000;

// CORS для всех запросов
app.use(cors());

// Разрешаем встраивание в iframe (убираем X-Frame-Options)
app.use((req, res, next) => {
  // Разрешаем встраивание в iframe с любого домена
  res.removeHeader('X-Frame-Options');
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
});

app.use(express.json());

// Статические файлы из текущей директории
app.use(express.static(__dirname));

// Корневой роут - отдаем client.html
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'client.html'));
});

// Роут для client.html (дублируем для удобства)
app.get('/client.html', (req, res) => {
  res.sendFile(join(__dirname, 'client.html'));
});

// Тестовый endpoint для проверки работы сервера
app.get('/api/test', (req, res) => {
  res.json({
    success: true,
    message: 'Сервер работает!',
    timestamp: new Date().toISOString(),
    port: port,
    environment: process.env.NODE_ENV || 'development'
  });
});

// Защита от одновременных запросов и кеширование
let isProcessing = false;
let lastPrice = null;
let lastPriceTime = 0;
const CACHE_TIME = 30000; // Кеш на 30 секунд
let processingTimeout = null;

// API endpoint для получения цены
app.get('/api/price', async (req, res) => {
  // Если запрос уже обрабатывается, возвращаем кешированную цену
  if (isProcessing) {
    if (lastPrice && (Date.now() - lastPriceTime) < CACHE_TIME) {
      console.log('♻️ Возвращаем кэшированную цену (запрос уже обрабатывается):', lastPrice);
      return res.json({
        success: true,
        price: lastPrice,
        updated: new Date(lastPriceTime).toISOString(),
        cached: true
      });
    }
    console.log('⚠️ Запрос уже обрабатывается, кэш недоступен. Возвращаем 503.');
    return res.status(503).json({
      success: false,
      error: 'Запрос уже обрабатывается, попробуйте через несколько секунд'
    });
  }

  isProcessing = true;
  // Таймаут для автоматического сброса флага isProcessing
  processingTimeout = setTimeout(() => {
    if (isProcessing) {
      console.error('⚠️ isProcessing флаг не был сброшен, принудительный сброс.');
      isProcessing = false;
    }
  }, 90000); // Сброс через 90 секунд

  let browser;
  let context;

  try {
    console.log('🚀 Начинаем получение цены...');

    // Запускаем headless Chromium
    console.log('📦 Запуск браузера...');
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // Требуется для некоторых сред
    });

    // Создаём контекст с User-Agent
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 }
    });

    const page = await context.newPage();
    
    console.log('✅ Браузер и страница созданы');

    // Двухэтапный запрос: сначала главная страница для получения cookies
    console.log('🌐 Шаг 1: Открываем главную страницу Grinex для получения cookies...');
    try {
      await page.goto('https://grinex.io', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await page.waitForTimeout(2000); // Ждём загрузки cookies
      console.log('✅ Главная страница загружена, cookies получены');
    } catch (e) {
      console.log('⚠️ Ошибка при загрузке главной страницы:', e.message);
      // Продолжаем, даже если главная не загрузилась
    }

    // Теперь открываем страницу торговли
    console.log('🌐 Шаг 2: Открываем страницу торговли...');
    try {
      await page.goto('https://grinex.io/trading/usdta7a5', {
        waitUntil: 'load',
        timeout: 90000,
      });
      console.log('✅ Страница торговли загружена');
    } catch (gotoError) {
      console.log('⚠️ Ошибка при загрузке страницы торговли:', gotoError.message);
      // Пробуем продолжить, может быть страница частично загрузилась
    }
    
    // Ждём загрузки JavaScript
    await page.waitForTimeout(5000);
    
    // Проверяем, не заблокирована ли страница защитой от ботов
    const pageContent = await page.content();
    const pageUrl = page.url();
    
    // Проверка URL - если редирект на защиту
    if (pageUrl.includes('exhkqyad') || pageUrl.includes('servicepipe.ru')) {
      throw new Error(`Страница заблокирована защитой от ботов (редирект): ${pageUrl}`);
    }
    
    // Проверка содержимого страницы - только если страница очень короткая
    if (pageContent.length < 3000) {
      console.log('⚠️ Страница слишком короткая (' + pageContent.length + ' символов), возможно заблокирована');
    } else {
      console.log('✅ Страница загружена (' + pageContent.length + ' символов)');
    }
    
    // Если страница содержит защиту И очень короткая - это точно блокировка
    if (pageContent.includes('servicepipe.ru') && pageContent.length < 5000) {
      throw new Error('Страница заблокирована защитой от ботов (servicepipe.ru)');
    }
    
    console.log('✅ Продолжаем парсинг, ждём загрузки данных...');

    // Ждём появления window.gon (самый надежный источник)
    try {
      console.log('⏳ Ждём загрузки window.gon...');
      await page.waitForFunction(
        () => {
          try {
            return window.gon && window.gon.ticker && window.gon.ticker.last;
          } catch (e) {
            return false;
          }
        },
        { timeout: 45000 } // Увеличено до 45 секунд
      );
      console.log('✅ window.gon загружен');
    } catch (waitError) {
      console.log('⚠️ window.gon не загрузился за 45 секунд, продолжаем...');
      // Даём дополнительное время на загрузку JavaScript
      await page.waitForTimeout(10000); // Увеличено до 10 секунд
      
      // Проверяем, может быть window.gon уже есть, но не с last
      const gonCheck = await page.evaluate(() => {
        try {
          if (window.gon) {
            console.log('window.gon существует:', Object.keys(window.gon));
            if (window.gon.ticker) {
              console.log('window.gon.ticker существует:', Object.keys(window.gon.ticker));
            }
          }
          return window.gon ? 'exists' : 'not_found';
        } catch (e) {
          return 'error: ' + e.message;
        }
      });
      console.log('🔍 Проверка window.gon:', gonCheck);
    }

    // Извлекаем цену - приоритет window.gon.ticker.last
    let price = null;
    let method = null;
    
    try {
      // Способ 1: Из window.gon.ticker.last (САМЫЙ НАДЕЖНЫЙ)
      console.log('🔍 Пытаемся получить цену из window.gon.ticker.last...');
      price = await page.evaluate(() => {
        try {
          // Проверяем наличие window.gon
          if (typeof window === 'undefined' || !window.gon) {
            console.log('⚠️ window.gon не существует');
            return null;
          }
          
          console.log('✅ window.gon существует');
          
          if (!window.gon.ticker) {
            console.log('⚠️ window.gon.ticker не существует');
            // Пробуем найти ticker в других местах
            if (window.gon.market) {
              console.log('Найден window.gon.market:', window.gon.market);
            }
            return null;
          }
          
          if (!window.gon.ticker.last) {
            console.log('⚠️ window.gon.ticker.last не существует');
            console.log('Доступные поля ticker:', Object.keys(window.gon.ticker));
            return null;
          }
          
          const lastPrice = window.gon.ticker.last;
          console.log('✅ Цена найдена в window.gon.ticker.last:', lastPrice);
          const parsed = parseFloat(lastPrice);
          
          if (isNaN(parsed) || parsed <= 0) {
            console.log('⚠️ Неверное значение цены:', lastPrice);
            return null;
          }
          
          return parsed;
        } catch (e) {
          console.log('⚠️ Ошибка при доступе к window.gon:', e.message);
          return null;
        }
      });
      
      if (price && price > 0) {
        method = 'window.gon.ticker.last';
        console.log('💰 Цена из window.gon:', price);
      } else {
        console.log('⚠️ Цена из window.gon не получена или равна 0');
      }
    } catch (e) {
      console.log('⚠️ Ошибка при получении window.gon:', e.message);
    }

    // Если window.gon не дал результат, ищем в таблице "Последние сделки"
    if (!price || price <= 0) {
      try {
        console.log('🔍 Ищем цену в таблице "Последние сделки"...');
        price = await page.evaluate(() => {
          // Находим секцию "Последние сделки"
          const lastTradesSection = Array.from(document.querySelectorAll('*'))
            .find(el => el.textContent && el.textContent.includes('Последние сделки') && el.textContent.length < 100);

          if (!lastTradesSection) {
            console.log('⚠️ Раздел "Последние сделки" не найден');
            return null;
          }

          // Находим таблицу или контейнер с данными сделок
          let container = lastTradesSection.parentElement;
          while (container && container !== document.body) {
            const rows = container.querySelectorAll('tr, [class*="row"], [class*="trade"]');
            if (rows.length > 1) { // Убеждаемся, что есть хотя бы одна строка данных после заголовка
              // Получаем первую строку данных (последняя сделка)
              const firstDataRow = rows[1]; // Предполагаем, что первая строка - заголовок
              const cells = firstDataRow.querySelectorAll('td, [class*="cell"], div, span');

              // Ищем цену в первой строке данных
              for (const cell of cells) {
                const text = cell.textContent.trim();
                const priceMatch = text.match(/(\d{2,3}\.\d{1,2})/);
                if (priceMatch) {
                  const candidate = parseFloat(priceMatch[1]);
                  if (candidate >= 50 && candidate <= 150) { // Проверяем диапазон цены
                    console.log('✅ Цена найдена в первой строке таблицы:', candidate);
                    return candidate;
                  }
                }
              }
            }
            container = container.parentElement;
          }
          return null;
        });

        if (price && price > 0) {
          method = 'table (Последние сделки)';
          console.log('💰 Цена из таблицы:', price);
        }
      } catch (e) {
        console.log('⚠️ Ошибка при парсинге таблицы:', e);
      }
    }

    // Если всё ещё нет цены, ищем в тексте после "Последние сделки"
    if (!price || price <= 0) {
      try {
        console.log('🔍 Ищем цену после текста "Последние сделки"...');
        price = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          const lastTradesIndex = bodyText.indexOf('Последние сделки');
          if (lastTradesIndex !== -1) {
            const afterText = bodyText.substring(lastTradesIndex + 'Последние сделки'.length);
            const priceMatch = afterText.match(/(\d{2,3}\.\d{1,2})/);
            if (priceMatch) {
              const candidate = parseFloat(priceMatch[1]);
              if (candidate >= 50 && candidate <= 150) {
                console.log('✅ Цена найдена после "Последние сделки":', candidate);
                return candidate;
              }
            }
          }
          return null;
        });

        if (price && price > 0) {
          method = 'text (Последние сделки)';
          console.log('💰 Цена после текста:', price);
        }
      } catch (e) {
        console.log('⚠️ Ошибка при поиске по тексту:', e);
      }
    }

    console.log('💰 Извлеченная цена:', price);

    if (!price || price <= 0) {
      throw new Error('Цена не найдена на странице. Не удалось извлечь цену ни одним из способов.');
    }

    // Обновляем кеш
    lastPrice = parseFloat(price).toFixed(2);
    lastPriceTime = Date.now();

    // Возвращаем цену в JSON формате
    const result = {
      success: true,
      price: lastPrice,
      updated: new Date().toISOString(),
      method: method || 'unknown'
    };

    console.log('✅ Успешно получена цена:', result.price);
    return res.json(result);

  } catch (error) {
    console.error('❌ Ошибка при получении цены:', error);
    console.error('❌ Stack:', error.stack);

    return res.status(500).json({
      success: false,
      error: error.message || 'Ошибка при получении цены',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  } finally {
    // Всегда закрываем контекст и браузер
    if (context) {
      try {
        await context.close();
        console.log('🔒 Контекст закрыт');
      } catch (closeError) {
        console.error('Ошибка при закрытии контекста:', closeError);
      }
    }
    if (browser) {
      try {
        await browser.close();
        console.log('🔒 Браузер закрыт');
      } catch (closeError) {
        console.error('Ошибка при закрытии браузера:', closeError);
      }
    }
    // Всегда сбрасываем флаг isProcessing и очищаем таймаут
    isProcessing = false;
    if (processingTimeout) {
      clearTimeout(processingTimeout);
      processingTimeout = null;
    }
    console.log('🏁 Запрос завершен, isProcessing сброшен.');
  }
});

// Обработка ошибок
process.on('unhandledRejection', (error) => {
  console.error('❌ Необработанная ошибка:', error);
  if (isProcessing) {
    isProcessing = false;
    if (processingTimeout) {
      clearTimeout(processingTimeout);
      processingTimeout = null;
    }
  }
});

process.on('uncaughtException', (error) => {
  console.error('❌ Критическая ошибка:', error);
  if (isProcessing) {
    isProcessing = false;
    if (processingTimeout) {
      clearTimeout(processingTimeout);
      processingTimeout = null;
    }
  }
  process.exit(1);
});

app.listen(port, () => {
  console.log(`🚀 Сервер запущен на порту ${port}`);
  console.log(`📊 Клиентская страница: http://localhost:${port}/`);
  console.log(`📊 Клиентская страница: http://localhost:${port}/client.html`);
  console.log(`🔗 API endpoint: http://localhost:${port}/api/price`);
  console.log(`🧪 Тестовый endpoint: http://localhost:${port}/api/test`);
  console.log('');
  console.log('⚠️  Убедитесь, что Playwright установлен: npx playwright install chromium');
});


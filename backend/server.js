'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store: sessionId -> { stage, data }
/** @type {Map<string, { stage: string, data: any, createdAt: number }>} */
const sessions = new Map();

const PORT = process.env.PORT || 3001;

function generateSessionId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function generateGiftLink() {
  const token = crypto.randomBytes(12).toString('hex');
  return `https://mock.amazon/gift/${token}`;
}

function getTemplates() {
  return [
    { id: 't1', label: 'Happy Birthday', imageUrl: '/happy-bday.png' },
    { id: 't2', label: 'Diwali', imageUrl: '/diwali.png' },
    { id: 't3', label: 'Raksha Bandhan', imageUrl: '/rakshabandhan.png' },
    { id: 't4', label: 'Sorry/Thank You', imageUrl: '/Sorry.png' }
  ];
}

function findTemplateById(templateId) {
  const t = getTemplates().find(x => x.id === templateId);
  return t || null;
}

function formatCurrencyInr(amount) {
  const number = Number(amount);
  if (Number.isNaN(number)) return '₹0';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(number);
}

function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return { id: sessionId, state: sessions.get(sessionId) };
  }
  const id = generateSessionId();
  const state = { stage: 'idle', data: {}, createdAt: Date.now() };
  sessions.set(id, state);
  return { id, state };
}

function normalizeAmount(message) {
  if (!message) return null;
  const digits = String(message).replace(/[^0-9]/g, '');
  if (!digits) return null;
  const value = parseInt(digits, 10);
  if (Number.isNaN(value)) return null;
  return value;
}

function isValidEmail(text) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(text).toLowerCase());
}

function isValidPhone(text) {
  const normalized = String(text).replace(/\s|-/g, '');
  return /^(\+?\d{10,15})$/.test(normalized);
}

function parseDeliveryDate(message) {
  if (!message) return { ok: false };
  const text = String(message).trim().toLowerCase();
  if (text === 'now' || text === 'today') {
    return { ok: true, kind: 'now', value: new Date() };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const date = new Date(text + 'T00:00:00');
    if (!isNaN(date.getTime())) {
      return { ok: true, kind: 'date', value: date };
    }
  }
  return { ok: false };
}

function summarizeOrder(data) {
  const recipientSummary =
    data.recipientType === 'self'
      ? 'self'
      : `${data.recipientType}: ${data.recipientValue}`;
  const personal =
    data.personalMessage && data.personalMessage.trim().length > 0
      ? `"${data.personalMessage}"`
      : '(none)';
  const dateLabel = data.deliveryKind === 'now' ? 'now' : data.deliveryDateISO;
  return (
    `Please review your order:\n` +
    `- Amount: ${formatCurrencyInr(data.amount)}\n` +
    `- Occasion: ${data.occasion}\n` +
    `- Recipient: ${recipientSummary}\n` +
    `- Personal message: ${personal}\n` +
    `- Delivery date: ${dateLabel}\n\n` +
    `Reply "confirm" to place order or "cancel" to abort.`
  );
}

app.post('/chat', (req, res) => {
  try {
    const { sessionId: incomingId, message } = req.body || {};
    const userMessage = typeof message === 'string' ? message.trim() : '';
    const { id: sessionId, state } = getOrCreateSession(incomingId);

    let reply = '';
    let ui = undefined; // optional UI hints for frontend (options, templates, confirm)

    // Greeting only when user says hi/hello/hey
    if (state.stage === 'idle') {
      if (/\b(hi|hello|hey)\b/i.test(userMessage)) {
        reply =
          '👋 Welcome to Amazon Pay Gift Cards – powered by Pine Labs!\n🎁 The simplest way to buy, gift, and share Amazon Pay Gift Cards – anytime, anywhere.\n\n✅ Instantly purchase gift cards\n✅ Share with friends & family on WhatsApp\n\nTap below to get started 👇\n\n🛒 Buy a Gift Card Now';
        state.stage = 'askOccasion';
        ui = {
          kind: 'occasionOptions',
          options: [
            { id: 'birthday', label: 'Birthday' },
            { id: 'thankyou', label: 'Thank You' },
            { id: 'diwali', label: 'Diwali' },
            { id: 'other', label: 'Other (custom)' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      reply = "Please say 'hi' to begin.";
      return res.json({ reply, sessionId });
    }

    // Ask Occasion (with Other -> custom text)
    if (state.stage === 'askOccasion') {
      const text = userMessage.toLowerCase();
      const known = ['birthday', 'thank you', 'thankyou', 'diwali', 'other'];
      if (!text) {
        reply = 'For what occasion you want to buy a gift card?';
        ui = {
          kind: 'occasionOptions',
          options: [
            { id: 'birthday', label: 'Birthday' },
            { id: 'thankyou', label: 'Thank You' },
            { id: 'diwali', label: 'Diwali' },
            { id: 'other', label: 'Other (custom)' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      if (known.includes(text)) {
        if (text === 'other') {
          state.stage = 'askOccasionCustom';
          reply = 'Please enter the occasion.';
          return res.json({ reply, sessionId });
        }
        state.data.occasion = text.replace('thankyou', 'thank you');
      } else {
        // Assume custom typed occasion as well
        state.data.occasion = userMessage;
      }
      state.stage = 'askTemplate';
      reply = 'Choose a gift card template.';
      ui = {
        kind: 'templatePicker',
        templates: getTemplates()
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'askOccasionCustom') {
      if (!userMessage) {
        reply = 'Please enter the occasion.';
        return res.json({ reply, sessionId });
      }
      state.data.occasion = userMessage;
      state.stage = 'askTemplate';
      reply = 'Choose a gift card template.';
      ui = {
        kind: 'templatePicker',
        templates: getTemplates()
      };
      return res.json({ reply, sessionId, ui });
    }

    // Template selection
    if (state.stage === 'askTemplate') {
      let templateId = null;
      const m = userMessage.toLowerCase();
      if (m.startsWith('template:')) {
        templateId = m.split(':')[1];
      } else if (/^t[0-9]+$/.test(m)) {
        templateId = m;
      }
      if (!templateId) {
        reply = 'Please select a template.';
        ui = {
          kind: 'templatePicker',
          templates: getTemplates()
        };
        return res.json({ reply, sessionId, ui });
      }
      state.data.templateId = templateId;
      state.stage = 'askAmount';
      reply = 'Select the amount or enter a custom amount.';
      ui = {
        kind: 'amountOptions',
        options: [
          { id: '500', label: '₹500' },
          { id: '1000', label: '₹1000' },
          { id: '2000', label: '₹2000' },
          { id: '5000', label: '₹5000' },
          { id: 'custom', label: 'Enter amount' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    // Ask Amount (>= 500)
    if (state.stage === 'askAmount') {
      let amount = normalizeAmount(userMessage);
      if (amount === null || amount <= 0) {
        reply = 'Please enter a valid amount.';
        ui = {
          kind: 'amountOptions',
          options: [
            { id: '500', label: '₹500' },
            { id: '1000', label: '₹1000' },
            { id: '2000', label: '₹2000' },
            { id: '5000', label: '₹5000' },
            { id: 'custom', label: 'Enter amount' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      state.data.amount = amount;
      state.stage = 'askRecipientEmail';
      reply =
        'Who would you like to send it to? Please enter recipient email id.';
      return res.json({ reply, sessionId });
    }

    // Recipient Email
    if (state.stage === 'askRecipientEmail') {
      if (!isValidEmail(userMessage)) {
        reply = 'Please provide a valid email address.';
        return res.json({ reply, sessionId });
      }
      state.data.recipientEmail = userMessage;
      state.stage = 'askMessage';
      reply = 'Please enter your gift card message.';
      return res.json({ reply, sessionId });
    }

    // Personal Message
    if (state.stage === 'askMessage') {
      state.data.personalMessage = userMessage || '';
      state.stage = 'confirm';
      const chosenTemplate = findTemplateById(state.data.templateId);
      const summary =
        `Here are the gift card details you have selected:\n` +
        `- Occasion: ${state.data.occasion}\n` +
        `- Template: ${
          chosenTemplate ? chosenTemplate.label : state.data.templateId
        }\n` +
        `- Amount: ${formatCurrencyInr(state.data.amount)}\n` +
        `- Recipient Email: ${state.data.recipientEmail}\n` +
        `- Message: ${state.data.personalMessage || '(none)'}\n\n` +
        `Type 'confirm' to place the order or 'cancel' to restart.`;
      reply = summary;
      ui = {
        kind: 'confirm',
        details: {
          occasion: state.data.occasion,
          templateId: state.data.templateId,
          templateLabel: chosenTemplate
            ? chosenTemplate.label
            : state.data.templateId,
          templateImageUrl: chosenTemplate ? chosenTemplate.imageUrl : null,
          amount: state.data.amount,
          currency: 'INR',
          recipientEmail: state.data.recipientEmail,
          personalMessage: state.data.personalMessage || ''
        }
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'confirm') {
      const text = userMessage.toLowerCase();
      if (text === 'confirm') {
        const link = generateGiftLink();
        const receipt = {
          orderId: generateSessionId().slice(0, 8),
          occasion: state.data.occasion,
          templateId: state.data.templateId,
          amount: state.data.amount,
          currency: 'INR',
          recipient: { type: 'email', value: state.data.recipientEmail },
          personalMessage: state.data.personalMessage || null,
          giftLink: link
        };
        state.stage = 'completed';
        reply = `🎉 Success! Your gift card is ready.\nGift link: ${link}\n\nDetails:\n${JSON.stringify(
          receipt,
          null,
          2
        )}`;
        return res.json({ reply, sessionId });
      }
      if (text === 'cancel') {
        state.stage = 'idle';
        state.data = {};
        reply = "Cancelled. Say 'hi' to start again.";
        return res.json({ reply, sessionId });
      }
      reply = "Please reply with 'confirm' or 'cancel'.";
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'completed') {
      // Allow restarting after completion
      state.stage = 'idle';
      state.data = {};
      reply = "Say 'hi' to start a new gift card.";
      return res.json({ reply, sessionId });
    }

    reply = "Sorry, I didn't understand that. Say 'hi' to start.";
    return res.json({ reply, sessionId });
  } catch (err) {
    console.error('/chat error', err);
    return res.status(500).json({
      reply: 'Something went wrong. Please try again.',
      sessionId: null
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});

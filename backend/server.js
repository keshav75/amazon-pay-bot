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

function parseBatchLead(message) {
  // Expected format: lead|name|company|email|phone|gstin
  if (!message) return null;
  const raw = String(message);
  if (!raw.toLowerCase().startsWith('lead|')) return null;
  const parts = raw.split('|');
  // parts[0] = lead
  const [_, name, company, email, phone, gstin] = parts;
  return {
    name: (name || '').trim(),
    company: (company || '').trim(),
    email: (email || '').trim(),
    phone: (phone || '').trim(),
    gstin: (gstin || '').trim()
  };
}

function generateBusinessRequestId() {
  const year = new Date().getFullYear();
  return `GC${year}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
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

    // Global restart handler: if user says hi/hello/hey at any time, show welcome + Start button
    if (/\b(hi|hello|hey)\b/i.test(userMessage)) {
      state.stage = 'awaitStart';
      state.data = {};
      reply =
        '👋 Welcome to Amazon Pay Gift Cards – powered by Pine Labs!\n🎁 The simplest way to buy, gift, and share Amazon Pay Gift Cards – anytime, anywhere.\n\n✅ Instantly purchase gift cards\n✅ Share with friends & family on WhatsApp\n\nTap below to get started 👇\n\n🛒 Buy a Gift Card Now';
      ui = {
        kind: 'start',
        options: [{ id: 'start', label: 'Buy a Gift Card' }]
      };
      return res.json({ reply, sessionId, ui });
    }

    // Greeting only when user says hi/hello/hey
    if (state.stage === 'idle') {
      if (/\b(hi|hello|hey)\b/i.test(userMessage)) {
        reply = 'Are you buying for yourself or for business?';
        state.stage = 'askBuyerType';
        ui = {
          kind: 'buyerTypeOptions',
          options: [
            { id: 'personal', label: 'Personal / Self' },
            { id: 'business', label: 'Business' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      reply = "Please say 'hi' to begin.";
      return res.json({ reply, sessionId });
    }

    // Buyer type selection
    if (state.stage === 'askBuyerType') {
      const text = userMessage.trim().toLowerCase();
      if (text === '2' || text === 'business') {
        // Begin business flow
        state.stage = 'bizWelcome';
        state.data.biz = { checksToday: 0 };
        reply =
          'Would you like to explore gift card solutions for your business?';
        ui = {
          kind: 'options',
          title: 'Business solutions',
          options: [
            { id: 'yes', label: '✅ Yes, get started' },
            { id: 'how', label: 'ℹ️ How does it work' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      if (text === '1' || text === 'personal' || text === 'self') {
        state.data.buyerType = 'personal';
        state.stage = 'askOccasion';
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
      // re-ask if invalid
      reply = 'Please choose Personal/Self or Business.';
      ui = {
        kind: 'buyerTypeOptions',
        options: [
          { id: 'personal', label: 'Personal / Self' },
          { id: 'business', label: 'Business' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    // Awaiting explicit Start button click
    if (state.stage === 'awaitStart') {
      const text = userMessage.trim().toLowerCase();
      if (text === 'start' || text.includes('buy')) {
        state.stage = 'askBuyerType';
        reply =
          '✨ Great! Let’s get started. Please tell us who you’re buying for:\n\n1️⃣ For Myself / Friends & Family\n2️⃣ For Business / Employees / Clients\n\n👉 Just reply with 1 or 2 to continue.';
        ui = {
          kind: 'buyerTypeOptions',
          options: [
            { id: 'personal', label: 'Personal / Self' },
            { id: 'business', label: 'Business' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      // Re-prompt start
      reply = 'Tap the button to begin: Buy a Gift Card';
      ui = {
        kind: 'start',
        options: [{ id: 'start', label: 'Buy a Gift Card' }]
      };
      return res.json({ reply, sessionId, ui });
    }

    // ===== Business Flow =====
    if (state.stage === 'bizWelcome') {
      const text = userMessage.trim().toLowerCase();
      if (text === 'how') {
        reply =
          'We capture your requirements, verify eligibility for discounts, share a quotation and PI, then process payment and issue gift cards within agreed timelines.';
        ui = {
          kind: 'options',
          title: 'Continue?',
          options: [{ id: 'yes', label: '✅ Yes, get started' }]
        };
        return res.json({ reply, sessionId, ui });
      }
      // proceed to lead capture (single-step form allowed)
      state.stage = 'bizLead';
      reply = 'Please share your business details';
      ui = { kind: 'bizLeadForm' };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizLead') {
      // Accept batch string from frontend (lead|name|company|email|phone|gstin)
      const batch = parseBatchLead(userMessage);
      if (!batch) {
        // fallback: show form again
        reply = 'Please share your business details';
        ui = { kind: 'bizLeadForm' };
        return res.json({ reply, sessionId, ui });
      }
      // validate
      if (!batch.name || !batch.company || !isValidEmail(batch.email)) {
        reply = 'Please provide valid Name, Company and Official Email.';
        ui = { kind: 'bizLeadForm' };
        return res.json({ reply, sessionId, ui });
      }
      const phoneOk = /^\+?\d{10,15}$/.test(
        String(batch.phone).replace(/\s|-/g, '')
      );
      if (!phoneOk) {
        reply = 'Please provide a valid phone number.';
        ui = { kind: 'bizLeadForm' };
        return res.json({ reply, sessionId, ui });
      }
      state.data.biz.name = batch.name;
      state.data.biz.company = batch.company;
      state.data.biz.email = batch.email;
      state.data.biz.phone = String(batch.phone).replace(/\s|-/g, '');
      state.data.biz.gstin =
        batch.gstin && batch.gstin.toLowerCase() !== 'skip' ? batch.gstin : '';
      state.data.biz.requestId = generateBusinessRequestId();
      state.stage = 'bizNeedsOccasion';
      reply = `✅ Thanks, ${
        state.data.biz.name.split(' ')[0] || 'there'
      }. Your request has been logged with Request ID ${
        state.data.biz.requestId
      }.\n\nPlease help us with your requirement. Choose an occasion:`;
      ui = {
        kind: 'options',
        title: 'Select Occasion',
        options: [
          { id: 'rewards', label: 'Rewards' },
          { id: 'festival', label: 'Festival' },
          { id: 'incentive', label: 'Incentive' },
          { id: 'sales', label: 'Sales Promo' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizNeedsOccasion') {
      state.data.biz.occasion = userMessage.toLowerCase();
      state.stage = 'bizNeedsDenomination';
      reply = 'Choose a denomination:';
      ui = {
        kind: 'options',
        title: 'Denomination',
        options: [
          { id: '100', label: '₹100' },
          { id: '500', label: '₹500' },
          { id: '1000', label: '₹1,000' },
          { id: 'custom', label: 'Custom' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizNeedsDenomination') {
      const t = userMessage.toLowerCase();
      if (t === 'custom') {
        state.stage = 'bizNeedsDenominationCustom';
        reply = 'Enter custom denomination (₹):';
        return res.json({ reply, sessionId });
      }
      const amt = normalizeAmount(userMessage);
      if (!amt || amt <= 0) {
        reply = 'Please enter a valid denomination (₹)';
        return res.json({ reply, sessionId });
      }
      state.data.biz.denomination = amt;
      state.stage = 'bizNeedsBudget';
      reply = 'Estimated total budget (₹)?';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizNeedsDenominationCustom') {
      const amt = normalizeAmount(userMessage);
      if (!amt || amt <= 0) {
        reply = 'Please enter a valid denomination (₹)';
        return res.json({ reply, sessionId });
      }
      state.data.biz.denomination = amt;
      state.stage = 'bizNeedsBudget';
      reply = 'Estimated total budget (₹)?';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizNeedsBudget') {
      const budget = normalizeAmount(userMessage);
      if (!budget || budget <= 0) {
        reply = 'Please enter a valid budget (₹)';
        return res.json({ reply, sessionId });
      }
      state.data.biz.budget = budget;
      state.stage = 'bizNeedsDelivery';
      reply = 'Preferred delivery method?';
      ui = {
        kind: 'options',
        title: 'Delivery method',
        options: [
          { id: 'bulk', label: 'Bulk File' },
          { id: 'direct', label: 'Direct SMS & Email' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizNeedsDelivery') {
      state.data.biz.delivery = userMessage.toLowerCase();
      state.stage = 'bizDiscount';
      reply =
        'We offer up to 2% discount for verified businesses. Checking eligibility...\n\n✅ GSTIN check: Valid\n✅ Email check: Verified company domain\n\n🎉 You are eligible for a 2% business discount.';
      ui = {
        kind: 'options',
        title: 'Continue',
        options: [{ id: 'continue', label: 'Proceed to quotation' }]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizDiscount') {
      const denom = state.data.biz.denomination;
      const budget = state.data.biz.budget;
      const count = Math.max(1, Math.floor(budget / denom));
      const gross = denom * count;
      const discount = Math.round(gross * 0.02);
      const net = gross - discount;
      state.data.biz.quote = { count, denom, gross, discount, net };
      state.stage = 'bizQuote';
      reply = `💰 Based on your inputs:\n\n• ${count} gift cards @ ${formatCurrencyInr(
        denom
      )} each = ${formatCurrencyInr(
        gross
      )}\n• Business discount (2%): -${formatCurrencyInr(
        discount
      )}\n• Net Payable: ${formatCurrencyInr(net)}\n• Delivery: ${
        state.data.biz.delivery === 'bulk'
          ? 'Bulk CSV within 24 hrs'
          : 'Direct SMS & Email'
      }\n• Platform fee: Waived\n\nWould you like us to generate a Proforma Invoice (PI)?`;
      ui = {
        kind: 'options',
        title: 'Quotation',
        options: [
          { id: 'yes', label: '✅ Yes, share PI' },
          { id: 'edit', label: '✏️ Edit requirements' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizQuote') {
      const t = userMessage.toLowerCase();
      if (t === 'edit') {
        state.stage = 'bizNeedsOccasion';
        reply = 'Let’s update your requirements. Choose an occasion:';
        ui = {
          kind: 'options',
          title: 'Select Occasion',
          options: [
            { id: 'rewards', label: 'Rewards' },
            { id: 'festival', label: 'Festival' },
            { id: 'incentive', label: 'Incentive' },
            { id: 'sales', label: 'Sales Promo' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      // assume yes
      state.stage = 'bizPI';
      reply = `📑 Proforma Invoice (PI) generated for Request ID ${
        state.data.biz.requestId
      }.\n\n• Value: ${formatCurrencyInr(
        state.data.biz.quote.net
      )} (after discount)\n• Validity: 7 working days\n\nSent to your email: ${
        state.data.biz.email
      }\nPlease upload your Purchase Order (PO) here.`;
      ui = {
        kind: 'downloads',
        title: 'Proforma Invoice',
        items: [
          {
            label: 'Proforma Invoice (PDF)',
            url: '/Proforma_Invoice_GC2025-002.pdf'
          }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizPI') {
      const t = userMessage.toLowerCase();
      if (t === 'continue' || t === 'upload' || t === 'po') {
        state.stage = 'bizPIUpload';
        reply = 'Please upload your Purchase Order (PO).';
        ui = { kind: 'uploadPO', title: 'Upload Purchase Order' };
        return res.json({ reply, sessionId, ui });
      }
      // if user already sent a filename, accept as PO
      if (t.includes('po_') || t.endsWith('.pdf')) {
        state.stage = 'bizPOValidated';
        reply =
          '✅ PO received and validated. You can now proceed with payment.\n\nPlease complete payment via the link below 👇\n[💳 Pay Now]\nPayment Options: UPI / NEFT / Netbanking\n\nFor assistance during payment, call 0124-6236000 (Mon–Fri, 10AM–6PM).';
        ui = { kind: 'payment', title: 'Mock Payment Gateway' };
        return res.json({ reply, sessionId, ui });
      }
      // re-show downloads and prompt
      reply = 'Download the PI and upload your PO to proceed.';
      ui = {
        kind: 'downloads',
        title: 'Proforma Invoice',
        items: [
          {
            label: 'Proforma Invoice (PDF)',
            url: '/Proforma_Invoice_GC2025-002.pdf'
          }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizPIUpload') {
      // treat any message as PO uploaded
      state.stage = 'bizPOValidated';
      reply =
        '✅ PO received and validated. You can now proceed with payment.\n\nPlease complete payment via the link below 👇\n[💳 Pay Now]\nPayment Options: UPI / NEFT / Netbanking\n\nFor assistance during payment, call 0124-6236000 (Mon–Fri, 10AM–6PM).';
      ui = { kind: 'payment', title: 'Mock Payment Gateway' };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizPOValidated') {
      const t = userMessage.toLowerCase();
      if (t.includes('paid') || t.includes('payment')) {
        state.stage = 'bizIssued';
        reply =
          '✅ Payment received. GST Invoice sent to your email & available here: [Download Invoice]';
        ui = {
          kind: 'download',
          title: 'GST Invoice',
          url: '/gst-invoice.pdf',
          label: 'Download Invoice (PDF)'
        };
        return res.json({ reply, sessionId, ui });
      }
      reply = 'Please confirm once payment is completed (type: paid).';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizIssued') {
      state.stage = 'bizFinal';
      reply =
        '🎉 Your Amazon Pay Gift Cards have been issued!\nDelivery Method: Bulk CSV file sent to your email.\nSample card: XXXX-XXXX-5678 (₹1,000, Valid till Dec 2026)\n\nDownload full file securely: [Download GCs]';
      ui = {
        kind: 'downloads',
        title: 'Downloads',
        items: [{ label: 'GC Delivery (PDF)', url: '/gc-delivery.pdf' }]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizFinal') {
      // support simple redemption check command
      const m = userMessage.match(/^check\s+gc\s*(\w+)/i);
      state.data.biz.checksToday = state.data.biz.checksToday || 0;
      if (m) {
        if (state.data.biz.checksToday >= 5) {
          reply =
            '⚠️ You’ve reached today’s limit of 5 redemption checks. For additional queries, please contact 0124-6236000.';
          return res.json({ reply, sessionId });
        }
        state.data.biz.checksToday += 1;
        reply = `✅ Gift Card ${m[1]} → Unredeemed, Balance ₹1,000`;
        return res.json({ reply, sessionId });
      }
      const t = userMessage.trim().toLowerCase();
      if (t === 'feedback') {
        state.stage = 'bizFeedback';
        reply =
          'We’d love your feedback. Please rate 1-5 and share any comments.';
        ui = { kind: 'feedbackForm' };
        return res.json({ reply, sessionId, ui });
      }
      if (t === 'offers') {
        reply =
          'Great! Early-bird offers for Diwali 2025 are available. Our team will reach out with details.';
        return res.json({ reply, sessionId });
      }
      reply =
        '🙏 Thank you for choosing Amazon Pay Gift Cards! Reply “offers” to explore festive offers or “feedback” to share feedback.';
      ui = {
        kind: 'options',
        title: 'What next?',
        options: [
          { id: 'offers', label: '🎁 Explore Festive Offers' },
          { id: 'feedback', label: '✅ Share Feedback' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizFeedback') {
      const text = userMessage.trim();
      const rating = parseInt(text, 10);
      state.data.biz.feedback = state.data.biz.feedback || {};
      if (!state.data.biz.feedback.rating && rating >= 1 && rating <= 5) {
        state.data.biz.feedback.rating = rating;
        reply = 'Thanks! Please share any comments (optional).';
        ui = { kind: 'feedbackForm' };
        return res.json({ reply, sessionId, ui });
      }
      if (text.length > 0) {
        state.data.biz.feedback.comments = text;
      }
      state.stage = 'bizFinal';
      reply = '🙏 Thanks for your feedback!';
      ui = {
        kind: 'options',
        title: 'What next?',
        options: [{ id: 'offers', label: '🎁 Explore Festive Offers' }]
      };
      return res.json({ reply, sessionId, ui });
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
        state.stage = 'completed';
        const lines = [
          '🎉 Success! Your gift card is sent on recipient email.',
          `Gift link: ${link}`,
          '',
          'Details:',
          `- Occasion: ${state.data.occasion}`,
          `- Template: ${state.data.templateId}`,
          `- Amount: ${formatCurrencyInr(state.data.amount)}`,
          `- Recipient: ${state.data.recipientEmail}`,
          `- Message: ${state.data.personalMessage || '(none)'}`
        ];
        reply = lines.join('\n');
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

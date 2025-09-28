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
  // Expected format: lead|fullName|company|phone|email|gstin|bankAccount|ifsc
  if (!message) return null;
  const raw = String(message);
  if (!raw.toLowerCase().startsWith('lead|')) return null;
  const parts = raw.split('|');
  // parts[0] = lead
  const [_, fullName, company, phone, email, gstin, bankAccount, ifsc] = parts;
  return {
    fullName: (fullName || '').trim(),
    company: (company || '').trim(),
    phone: (phone || '').trim(),
    email: (email || '').trim(),
    gstin: (gstin || '').trim(),
    bankAccount: (bankAccount || '').trim(),
    ifsc: (ifsc || '').trim()
  };
}

function generateBusinessRequestId() {
  const year = new Date().getFullYear();
  return `GC${year}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateOrderSummary(bizData) {
  if (bizData.orders && bizData.orders.length > 0) {
    // Multiple orders format
    const orderLines = bizData.orders
      .map(order => {
        const denom = parseInt(order.denomination);
        const count = parseInt(order.count);
        const subtotal = denom * count;
        return `• ${count} gift cards @ ₹${denom} each = ₹${subtotal.toLocaleString()}`;
      })
      .join('\n');

    return orderLines;
  } else {
    // Legacy single order format
    return `• ${bizData.quantity} gift cards @ ₹${
      bizData.denomination
    } each = ₹${bizData.totalAmount.toLocaleString()}`;
  }
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
        '👋 Welcome to Amazon Pay Gift Cards – powered by Pine Labs!\nFreedom of choice, easy to use, and loved by everyone.\n\n✅ Buy instantly for business or personal use\n🎁 Simple gifting for employees, clients, family & friends\n\n👉 Ready to get started? Tap below:\n🛒 Buy Gift Cards';
      ui = {
        kind: 'start',
        options: [{ id: 'start', label: '🛒 Buy Gift Cards' }]
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
        // Begin business flow directly
        state.stage = 'bizOptions';
        state.data.biz = { checksToday: 0 };
        reply =
          '✨ How can we help you today?\n\n1️⃣ Purchase Gift Cards for my business\n2️⃣ View past orders\n\n👉 Reply with 1 or 2';
        ui = {
          kind: 'options',
          title: 'Business Options',
          options: [
            { id: 'purchase', label: '1️⃣ Purchase Gift Cards for my business' },
            { id: 'reports', label: '2️⃣ View past orders' }
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
          "✨ Great! Tell us who you're buying for:\n\n1️⃣ Myself / Friends & Family\n2️⃣ My Business (Employees / Clients)\n\n👉 Reply with 1 or 2";
        ui = {
          kind: 'buyerTypeOptions',
          options: [
            { id: 'personal', label: '1️⃣ Myself / Friends & Family' },
            { id: 'business', label: '2️⃣ My Business (Employees / Clients)' }
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
      // proceed to business options
      state.stage = 'bizOptions';
      reply =
        '✨ How can we help you today?\n\n1️⃣ Purchase Gift Cards for my business\n2️⃣ View past orders\n\n👉 Reply with 1 or 2';
      ui = {
        kind: 'options',
        title: 'Business Options',
        options: [
          { id: 'purchase', label: '1️⃣ Purchase Gift Cards for my business' },
          { id: 'reports', label: '2️⃣ View past orders' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    // Business options selection
    if (state.stage === 'bizOptions') {
      const text = userMessage.trim().toLowerCase();
      if (text === '1' || text === 'purchase') {
        // proceed to business verification
        state.stage = 'bizVerification';
        reply =
          '👍 Great! To get you started, please share a few quick details.';
        ui = { kind: 'bizVerificationForm' };
        return res.json({ reply, sessionId, ui });
      }
      if (text === '2' || text === 'reports') {
        // proceed to reports and queries
        state.stage = 'bizReports';
        reply =
          '📊 Welcome to Reports & Queries. What would you like to do?\n\n1️⃣ Download past order invoices\n2️⃣ Download past delivery reports (CSV)\n3️⃣ Raise a query\n\n👉 Reply with 1, 2, or 3';
        ui = {
          kind: 'options',
          title: 'Reports & Queries',
          options: [
            { id: 'invoices', label: '1️⃣ Download past order invoices' },
            {
              id: 'delivery',
              label: '2️⃣ Download past delivery reports (CSV)'
            },
            { id: 'query', label: '3️⃣ Raise a query' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      // re-ask if invalid
      reply =
        '✨ How can we help you today?\n\n1️⃣ Purchase Gift Cards for my business\n2️⃣ View past orders\n\n👉 Reply with 1 or 2';
      ui = {
        kind: 'options',
        title: 'Business Options',
        options: [
          { id: 'purchase', label: '1️⃣ Purchase Gift Cards for my business' },
          { id: 'reports', label: '2️⃣ View past orders' }
        ]
      };
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

    // Business verification form handling
    if (state.stage === 'bizVerification') {
      const text = userMessage.toLowerCase();
      if (text === 'proceed') {
        // Show the verification form directly
        ui = { kind: 'bizVerificationForm' };
        return res.json({ reply, sessionId, ui });
      }

      // Accept batch string from frontend with enhanced business details
      const batch = parseBatchLead(userMessage);
      if (!batch) {
        // fallback: show form again
        ui = { kind: 'bizVerificationForm' };
        return res.json({ reply, sessionId, ui });
      }
      // validate required fields
      if (
        !batch.fullName ||
        !batch.company ||
        !isValidEmail(batch.email) ||
        !batch.phone ||
        !batch.gstin ||
        !batch.bankAccount ||
        !batch.ifsc
      ) {
        reply =
          'Please provide valid Name, Company, Phone, Email, GSTIN, Bank Account, and IFSC.';
        ui = { kind: 'bizVerificationForm' };
        return res.json({ reply, sessionId, ui });
      }

      // Validate phone number
      const phoneOk = /^\+?\d{10,15}$/.test(
        String(batch.phone).replace(/\s|-/g, '')
      );
      if (!phoneOk) {
        reply = 'Please provide a valid phone number.';
        ui = { kind: 'bizVerificationForm' };
        return res.json({ reply, sessionId, ui });
      }

      state.data.biz.name = batch.fullName;
      state.data.biz.company = batch.company;
      state.data.biz.phone = String(batch.phone).replace(/\s|-/g, '');
      state.data.biz.email = batch.email;
      state.data.biz.gstin = batch.gstin;
      state.data.biz.bankAccount = batch.bankAccount;
      state.data.biz.ifsc = batch.ifsc;
      state.data.biz.requestId = generateBusinessRequestId();

      // Check if GSTIN has 4 or more zeros (like 00000000)
      const gstinZeros = (batch.gstin || '').match(/0/g) || [];
      if (gstinZeros.length >= 4) {
        // Verification failed - show error and retry form
        reply =
          '❌ Verification Failed: Account & GST must belong to the same company. Please retry.';
        ui = { kind: 'bizVerificationForm' };
        return res.json({ reply, sessionId, ui });
      } else {
        // Verification successful - proceed to occasion selection
        state.data.biz.verified = true;
        state.data.biz.discountEligible = true;
        state.data.biz.discountPercent = 1;
        state.stage = 'bizNeedsOccasion';
        reply =
          "✅ Verification Complete! You qualify for 1% discount. Now let's customize your gift card order.";
        ui = {
          kind: 'options',
          title: 'Pick an Occasion',
          options: [
            { id: 'thankyou', label: '1️⃣ Thank You' },
            { id: 'performer', label: '2️⃣ Best Performer' },
            { id: 'festivities', label: '3️⃣ Happy Festivities' },
            { id: 'custom', label: '4️⃣ Custom message' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
    }

    if (state.stage === 'bizNeedsOccasion') {
      const occasion = userMessage.toLowerCase();
      if (occasion === 'custom') {
        state.stage = 'bizNeedsOccasionCustom';
        reply = 'Please enter your custom message (up to 60 characters):';
        return res.json({ reply, sessionId });
      }
      state.data.biz.occasion = userMessage;
      state.stage = 'bizNeedsOrderDetails';
      reply = '💰 Please enter denomination and quantity.';
      ui = { kind: 'bizOrderForm' };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizNeedsOccasionCustom') {
      if (!userMessage || userMessage.length > 60) {
        reply = 'Please enter a custom message (up to 60 characters):';
        return res.json({ reply, sessionId });
      }
      state.data.biz.occasion = userMessage;
      state.stage = 'bizNeedsOrderDetails';
      reply = '💰 Please enter denomination and quantity.';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizNeedsOrderDetails') {
      // Handle new format with multiple orders from frontend
      if (userMessage.startsWith('orders|')) {
        const parts = userMessage.split('|');
        try {
          const orders = JSON.parse(parts[1]);
          const total = parseInt(parts[2]) || 0;

          if (orders && orders.length > 0 && total > 0) {
            state.data.biz.orders = orders;
            state.data.biz.totalAmount = total;
            // Calculate total quantity for summary
            state.data.biz.quantity = orders.reduce(
              (sum, order) => sum + parseInt(order.count),
              0
            );

            state.stage = 'bizNeedsDelivery';
            reply =
              '📧 Confirm your delivery email: ' +
              state.data.biz.email +
              '\n👉 You can edit if needed.';
            ui = { kind: 'bizDeliveryForm', email: state.data.biz.email };
            return res.json({ reply, sessionId, ui });
          } else {
            reply = 'Please enter valid order details';
            ui = { kind: 'bizOrderForm' };
            return res.json({ reply, sessionId, ui });
          }
        } catch (error) {
          reply = 'Please enter valid order details';
          ui = { kind: 'bizOrderForm' };
          return res.json({ reply, sessionId, ui });
        }
      }

      // Handle legacy format for backward compatibility
      if (userMessage.startsWith('order|')) {
        const parts = userMessage.split('|');
        const quantity = parseInt(parts[1]) || 0;
        const denomination = parseInt(parts[2]) || 0;
        const total = quantity * denomination;

        if (quantity > 0 && denomination > 0) {
          state.data.biz.orders = [
            {
              denomination: denomination.toString(),
              count: quantity.toString()
            }
          ];
          state.data.biz.quantity = quantity;
          state.data.biz.denomination = denomination;
          state.data.biz.totalAmount = total;
          state.stage = 'bizNeedsDelivery';
          reply =
            '📧 Confirm your delivery email: ' +
            state.data.biz.email +
            '\n👉 You can edit if needed.';
          ui = { kind: 'bizDeliveryForm', email: state.data.biz.email };
          return res.json({ reply, sessionId, ui });
        } else {
          reply = 'Please enter valid quantity and denomination';
          ui = { kind: 'bizOrderForm' };
          return res.json({ reply, sessionId, ui });
        }
      }

      // Parse order details - look for patterns like "150 cards x ₹100" or "₹15,000"
      const text = userMessage.toLowerCase();
      const amountMatch = text.match(/₹?(\d+(?:,\d+)*)/);
      const quantityMatch = text.match(/(\d+)\s*cards?/);

      if (amountMatch && quantityMatch) {
        const quantity = parseInt(quantityMatch[1]);
        const denomination = parseInt(amountMatch[1].replace(/,/g, ''));
        const total = quantity * denomination;

        state.data.biz.quantity = quantity;
        state.data.biz.denomination = denomination;
        state.data.biz.totalAmount = total;
      } else if (amountMatch) {
        // Just budget provided
        const budget = parseInt(amountMatch[1].replace(/,/g, ''));
        state.data.biz.budget = budget;
        state.data.biz.denomination = 1000; // default denomination
        state.data.biz.quantity = Math.floor(budget / 1000);
        state.data.biz.totalAmount = budget;
      } else {
        reply =
          'Please provide order details in the format: "150 cards x ₹100 each" or "₹15,000"';
        ui = { kind: 'bizOrderForm' };
        return res.json({ reply, sessionId, ui });
      }

      state.stage = 'bizNeedsDelivery';
      reply =
        '📧 Confirm your delivery email: ' +
        state.data.biz.email +
        '\n👉 You can edit if needed.';
      ui = {
        kind: 'options',
        title: 'Delivery Email',
        options: [
          { id: 'confirm', label: '✅ Confirm' },
          { id: 'edit', label: '✏️ Edit Email' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizNeedsDelivery') {
      const text = userMessage.toLowerCase();

      if (text === 'confirm') {
        // Use the current email
        state.data.biz.deliveryEmail = state.data.biz.email;
        state.stage = 'bizOrderSummary';
        const discount = state.data.biz.discountEligible
          ? Math.round(state.data.biz.totalAmount * 0.01)
          : 0;
        const netAmount = state.data.biz.totalAmount - discount;

        const orderSummary = generateOrderSummary(state.data.biz);
        reply =
          "Here's a quick summary of your request:\n\n" +
          orderSummary +
          '\n• Business Discount (1%): –₹' +
          discount +
          '\n• Net Payable: ₹' +
          netAmount +
          '\n• Delivery: CSV to ' +
          state.data.biz.deliveryEmail +
          '\n• Platform Fee: Waived\n\n👉 Would you like us to generate a Proforma Invoice (PI)?';
        ui = {
          kind: 'options',
          title: 'Order Summary',
          options: [
            { id: 'yes', label: '1️⃣ Yes, share PI' },
            { id: 'edit', label: '2️⃣ Edit order' },
            { id: 'form', label: '3️⃣ Enter requirements manually' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }

      if (text === 'edit') {
        // Open email edit form
        reply = 'Please enter your delivery email:';
        ui = { kind: 'bizDeliveryForm', email: state.data.biz.email };
        return res.json({ reply, sessionId, ui });
      }

      // Handle email from form or text input
      if (isValidEmail(userMessage)) {
        state.data.biz.deliveryEmail = userMessage;
        state.stage = 'bizOrderSummary';
        const discount = state.data.biz.discountEligible
          ? Math.round(state.data.biz.totalAmount * 0.01)
          : 0;
        const netAmount = state.data.biz.totalAmount - discount;

        const orderSummary = generateOrderSummary(state.data.biz);
        reply =
          "Here's a quick summary of your request:\n\n" +
          orderSummary +
          '\n• Business Discount (1%): –₹' +
          discount +
          '\n• Net Payable: ₹' +
          netAmount +
          '\n• Delivery: CSV to ' +
          state.data.biz.deliveryEmail +
          '\n• Platform Fee: Waived\n\n👉 Would you like us to generate a Proforma Invoice (PI)?';
        ui = {
          kind: 'options',
          title: 'Order Summary',
          options: [
            { id: 'yes', label: '1️⃣ Yes, share PI' },
            { id: 'edit', label: '2️⃣ Edit order' },
            { id: 'form', label: '3️⃣ Enter requirements manually' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      } else {
        // Re-prompt with buttons
        reply =
          '📧 Confirm your delivery email: ' +
          state.data.biz.email +
          '\n👉 You can edit if needed.';
        ui = {
          kind: 'options',
          title: 'Delivery Email',
          options: [
            { id: 'confirm', label: '✅ Confirm' },
            { id: 'edit', label: '✏️ Edit Email' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
    }

    // Handle order summary response
    if (state.stage === 'bizOrderSummary') {
      const text = userMessage.toLowerCase();
      if (text === '1' || text === 'yes') {
        // Generate proforma invoice
        state.stage = 'bizPaymentInfo';
        const discount = state.data.biz.discountEligible
          ? Math.round(state.data.biz.totalAmount * 0.01)
          : 0;
        const netAmount = state.data.biz.totalAmount - discount;
        reply = `📑 PI generated → Request ID: ${
          state.data.biz.requestId
        }\n• Value: ₹${netAmount.toLocaleString()} (after discount)\n• Validity: 7 working days\n📧 Sent to: ${
          state.data.biz.deliveryEmail
        }`;
        ui = {
          kind: 'options',
          title: 'Proforma Invoice Generated',
          options: [{ id: 'proceed', label: 'Proceed' }]
        };
        return res.json({ reply, sessionId, ui });
      }
      if (text === '2' || text === 'edit') {
        // Go back to occasion selection
        state.stage = 'bizNeedsOccasion';
        reply =
          "Let's update your requirements. Choose an occasion:\n1️⃣ Thank You 🙏\n2️⃣ Best Performer 🏆\n3️⃣ Happy Festivities 🎉\n4️⃣ ✍️ Custom message (up to 60 characters)";
        ui = {
          kind: 'options',
          title: 'Select Occasion',
          options: [
            { id: 'thankyou', label: '1️⃣ Thank You 🙏' },
            { id: 'bestperformer', label: '2️⃣ Best Performer 🏆' },
            { id: 'festivities', label: '3️⃣ Happy Festivities 🎉' },
            { id: 'custom', label: '4️⃣ ✍️ Custom message' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      if (text === '3' || text === 'form') {
        // Open manual requirements form
        state.stage = 'bizManualRequirements';
        reply = 'Please enter your requirements manually:';
        ui = { kind: 'bizOrderForm' };
        return res.json({ reply, sessionId, ui });
      }
      // re-ask if invalid
      reply =
        'Please choose:\n1️⃣ Yes, share PI\n2️⃣ Edit order\n3️⃣ Enter requirements manually';
      ui = {
        kind: 'options',
        title: 'Order Summary',
        options: [
          { id: 'yes', label: '1️⃣ Yes, share PI' },
          { id: 'edit', label: '2️⃣ Edit order' },
          { id: 'form', label: '3️⃣ Enter requirements manually' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    // Handle manual requirements form submission
    if (state.stage === 'bizManualRequirements') {
      // Handle form submission from frontend
      if (userMessage.startsWith('order|')) {
        const parts = userMessage.split('|');
        const quantity = parseInt(parts[1]) || 0;
        const denomination = parseInt(parts[2]) || 0;
        const total = quantity * denomination;

        if (quantity > 0 && denomination > 0) {
          state.data.biz.quantity = quantity;
          state.data.biz.denomination = denomination;
          state.data.biz.totalAmount = total;
          state.stage = 'bizOrderSummary';

          // Show updated summary
          const discount = state.data.biz.discountEligible
            ? Math.round(state.data.biz.totalAmount * 0.01)
            : 0;
          const netAmount = state.data.biz.totalAmount - discount;

          const orderSummary = generateOrderSummary(state.data.biz);
          reply =
            "Here's your updated order summary:\n\n" +
            orderSummary +
            '\n• Business Discount (1%): –₹' +
            discount +
            '\n• Net Payable: ₹' +
            netAmount +
            '\n• Delivery: CSV to ' +
            state.data.biz.deliveryEmail +
            '\n• Platform Fee: Waived\n\n👉 Would you like us to generate a Proforma Invoice (PI)?';
          ui = {
            kind: 'options',
            title: 'Order Summary',
            options: [
              { id: 'yes', label: '1️⃣ Yes, share PI' },
              { id: 'edit', label: '2️⃣ Edit order' },
              { id: 'form', label: '3️⃣ Enter requirements manually' }
            ]
          };
          return res.json({ reply, sessionId, ui });
        } else {
          reply = 'Please enter valid quantity and denomination';
          ui = { kind: 'bizOrderForm' };
          return res.json({ reply, sessionId, ui });
        }
      }

      // Fallback to text input parsing
      const text = userMessage.toLowerCase();
      const amountMatch = text.match(/₹?(\d+(?:,\d+)*)/);
      const quantityMatch = text.match(/(\d+)\s*cards?/);

      if (amountMatch && quantityMatch) {
        const quantity = parseInt(quantityMatch[1]);
        const denomination = parseInt(amountMatch[1].replace(/,/g, ''));
        const total = quantity * denomination;

        state.data.biz.quantity = quantity;
        state.data.biz.denomination = denomination;
        state.data.biz.totalAmount = total;
        state.stage = 'bizOrderSummary';

        // Show updated summary
        const discount = state.data.biz.discountEligible
          ? Math.round(state.data.biz.totalAmount * 0.01)
          : 0;
        const netAmount = state.data.biz.totalAmount - discount;

        const orderSummary = generateOrderSummary(state.data.biz);
        reply =
          "Here's your updated order summary:\n\n" +
          orderSummary +
          '\n• Business Discount (1%): –₹' +
          discount +
          '\n• Net Payable: ₹' +
          netAmount +
          '\n• Delivery: CSV to ' +
          state.data.biz.deliveryEmail +
          '\n• Platform Fee: Waived\n\n👉 Would you like us to generate a Proforma Invoice (PI)?';
        ui = {
          kind: 'options',
          title: 'Order Summary',
          options: [
            { id: 'yes', label: '1️⃣ Yes, share PI' },
            { id: 'edit', label: '2️⃣ Edit order' },
            { id: 'form', label: '3️⃣ Enter requirements manually' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      } else {
        reply =
          'Please provide order details in the format: "150 cards x ₹100 each" or use the form';
        ui = { kind: 'bizOrderForm' };
        return res.json({ reply, sessionId, ui });
      }
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

    if (state.stage === 'bizPaymentInfo') {
      const text = userMessage.toLowerCase();
      if (text === 'proceed') {
        state.stage = 'bizPaymentOptions';
        reply =
          '💳 Before completing your payment, please keep in mind:\n\n• Carefully review your PI to ensure all details are correct.\n• For bank transfers, use the same GST company account shared during verification.\n• You can also pay conveniently using a Credit Card.';
        ui = {
          kind: 'options',
          title: 'Payment Instructions',
          options: [{ id: 'understand', label: '✅ I Understand' }]
        };
        return res.json({ reply, sessionId, ui });
      }
      // Re-show proceed button if invalid input
      const discount = state.data.biz.discountEligible
        ? Math.round(state.data.biz.totalAmount * 0.01)
        : 0;
      const netAmount = state.data.biz.totalAmount - discount;
      reply = `📑 PI generated → Request ID: ${
        state.data.biz.requestId
      }\n• Value: ₹${netAmount.toLocaleString()} (after discount)\n• Validity: 7 working days\n📧 Sent to: ${
        state.data.biz.deliveryEmail
      }`;
      ui = {
        kind: 'options',
        title: 'Proforma Invoice Generated',
        options: [{ id: 'proceed', label: 'Proceed' }]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizPaymentOptions') {
      const text = userMessage.toLowerCase();
      if (text === 'understand') {
        state.stage = 'bizPaymentMethod';
        reply = 'Payment Options (quick replies):';
        ui = {
          kind: 'options',
          title: 'Select Payment Method',
          options: [
            { id: 'neft', label: 'NEFT / Netbanking' },
            { id: 'credit', label: 'Credit Card' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      // Re-show payment instructions if invalid input
      reply =
        '💳 Before completing your payment, please keep in mind:\n\n• Carefully review your PI to ensure all details are correct.\n• For bank transfers, use the same GST company account shared during verification.\n• You can also pay conveniently using a Credit Card.';
      ui = {
        kind: 'options',
        title: 'Payment Instructions',
        options: [{ id: 'understand', label: '✅ I Understand' }]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizPaymentMethod') {
      const text = userMessage.toLowerCase();
      if (text === 'neft' || text === 'credit') {
        state.stage = 'bizPaymentProcessing';
        const paymentMethod =
          text === 'neft' ? 'NEFT / Netbanking' : 'Credit Card';
        reply = `You selected: ${paymentMethod}\n\nPlease complete payment using your preferred method. Once payment is confirmed, your gift cards will be processed and delivered.`;
        ui = { kind: 'payment', title: 'Complete Payment' };
        return res.json({ reply, sessionId, ui });
      }
      // Re-show payment options if invalid input
      reply = 'Payment Options (quick replies):';
      ui = {
        kind: 'options',
        title: 'Select Payment Method',
        options: [
          { id: 'neft', label: 'NEFT / Netbanking' },
          { id: 'credit', label: 'Credit Card' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizPaymentProcessing') {
      const t = userMessage.toLowerCase();
      if (
        t.includes('paid') ||
        t.includes('payment') ||
        t.includes('complete')
      ) {
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
        '🎉 Your Amazon Pay Gift Cards are ready!\n\n• Bulk CSV file sent to: ' +
        (state.data.biz.deliveryEmail || state.data.biz.email) +
        '\n• Sample Card: XXXX-XXXX-5678 (₹1,000, valid till Dec 2026)\n\n✅ GST Invoice also sent to your email → [Download Invoice]';
      ui = {
        kind: 'downloads',
        title: 'Downloads',
        items: [
          { label: 'GST Invoice (PDF)', url: '/gst-invoice.pdf' },
          { label: 'GC Delivery (PDF)', url: '/gc-delivery.pdf' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    // Reports and Queries functionality
    if (state.stage === 'bizReports') {
      const text = userMessage.toLowerCase();
      if (text === '1' || text === 'invoices') {
        state.stage = 'bizReportInvoices';
        reply = 'Please enter your Request ID (e.g., GC2025-7F2A).';
        return res.json({ reply, sessionId });
      }
      if (text === '2' || text === 'delivery') {
        state.stage = 'bizReportDelivery';
        reply = 'Please enter your Request ID to fetch the delivery report.';
        return res.json({ reply, sessionId });
      }
      if (text === '3' || text === 'query') {
        state.stage = 'bizReportQuery';
        reply = 'Please type your query below 👇';
        return res.json({ reply, sessionId });
      }
      // re-ask if invalid
      reply =
        '📊 Welcome to Reports & Queries. What would you like to do?\n\n1️⃣ Download past order invoices\n2️⃣ Download past delivery reports (CSV)\n3️⃣ Raise a query\n\n👉 Reply with **1**, **2**, or **3**';
      ui = {
        kind: 'options',
        title: 'Reports & Queries',
        options: [
          { id: 'invoices', label: '1️⃣ Download past order invoices' },
          { id: 'delivery', label: '2️⃣ Download past delivery reports (CSV)' },
          { id: 'query', label: '3️⃣ Raise a query' }
        ]
      };
      return res.json({ reply, sessionId, ui });
    }

    if (state.stage === 'bizReportInvoices') {
      const requestId = userMessage.trim();
      if (requestId) {
        state.stage = 'bizReportComplete';
        reply = `✅ Invoice for Request ID ${requestId}\n📧 Sent to ${
          state.data.biz.email || 'your email'
        }\n📥 Download here → [Download Invoice]`;
        ui = {
          kind: 'download',
          title: 'Invoice',
          url: '/gst-invoice.pdf',
          label: 'Download Invoice (PDF)'
        };
        return res.json({ reply, sessionId, ui });
      }
      reply = 'Please enter your **Request ID** (e.g., GC2025-7F2A).';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizReportDelivery') {
      const requestId = userMessage.trim();
      if (requestId) {
        state.stage = 'bizReportComplete';
        reply = `✅ Delivery Report for Request ID ${requestId}\n📧 Sent to ${
          state.data.biz.email || 'your email'
        }\n📥 Download securely → [Download Report]`;
        ui = {
          kind: 'download',
          title: 'Delivery Report',
          url: '/gc-delivery.pdf',
          label: 'Download Report (PDF)'
        };
        return res.json({ reply, sessionId, ui });
      }
      reply = 'Please enter your **Request ID** to fetch the delivery report.';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizReportQuery') {
      const query = userMessage.trim();
      if (query) {
        state.stage = 'bizReportComplete';
        reply =
          '✅ Thanks! Your query has been logged.\nOur team will respond within 24 working hours.';
        return res.json({ reply, sessionId });
      }
      reply = 'Please type your query below 👇';
      return res.json({ reply, sessionId });
    }

    if (state.stage === 'bizReportComplete') {
      const text = userMessage.toLowerCase();
      if (text === '1' || text === 'purchase') {
        state.stage = 'bizOptions';
        reply =
          '✨ How can we help you today?\n\n1️⃣ Purchase Gift Cards for my business\n2️⃣ View past orders\n\n👉 Reply with 1 or 2';
        ui = {
          kind: 'options',
          title: 'Business Options',
          options: [
            { id: 'purchase', label: '1️⃣ Purchase Gift Cards for my business' },
            { id: 'reports', label: '2️⃣ View past orders' }
          ]
        };
        return res.json({ reply, sessionId, ui });
      }
      if (text === '2' || text === 'exit') {
        state.stage = 'idle';
        state.data = {};
        reply =
          'Thank you for using Amazon Pay Gift Cards! Say "hi" to start again.';
        return res.json({ reply, sessionId });
      }
      reply =
        "That's it for now! Would you like to go back to:\n1️⃣ Purchase Gift Cards\n2️⃣ Exit\n\n👉 Reply with 1 or 2";
      ui = {
        kind: 'options',
        title: 'What next?',
        options: [
          { id: 'purchase', label: '1️⃣ Purchase Gift Cards' },
          { id: 'exit', label: '2️⃣ Exit' }
        ]
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
            "⚠️ You've reached today's limit of 5 redemption checks. For additional queries, please contact 0124-6236000.";
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
          "We'd love your feedback. Please rate 1-5 and share any comments.";
        ui = { kind: 'feedbackForm' };
        return res.json({ reply, sessionId, ui });
      }
      if (t === 'offers') {
        reply =
          'Great! Early-bird offers for Diwali 2025 are available. Our team will reach out with details.';
        return res.json({ reply, sessionId });
      }
      reply =
        "✅ Order complete!\n\nWe'd love to hear your feedback to make this even smoother.";
      ui = {
        kind: 'options',
        title: 'After-Sales & Feedback',
        options: [{ id: 'feedback', label: '🌟 Share Feedback' }]
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

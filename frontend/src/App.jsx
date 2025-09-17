import React, { useEffect, useRef, useState } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

function MessageBubble({ author, text }) {
  const isBot = author === 'bot';
  return (
    <div className={`row ${isBot ? 'left' : 'right'}`}>
      <div className={`bubble ${isBot ? 'bot' : 'user'}`}>
        {renderTextWithLinks(text)}
      </div>
    </div>
  );
}

function renderTextWithLinks(text) {
  if (!text) return null;
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = String(text).split(urlRegex);
  return parts.map((part, idx) => {
    if (urlRegex.test(part)) {
      const href = part;
      const display = href.includes('/gift/')
        ? 'Open gift'
        : href.length > 40
        ? href.slice(0, 38) + '…'
        : href;
      return (
        <a
          key={`url-${idx}`}
          href={href}
          target='_blank'
          rel='noopener noreferrer'>
          {display}
        </a>
      );
    }
    // preserve newlines
    const withBreaks = part.split('\n');
    return withBreaks.map((line, i) => (
      <React.Fragment key={`t-${idx}-${i}`}>
        {line}
        {i < withBreaks.length - 1 ? <br /> : null}
      </React.Fragment>
    ));
  });
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [ui, setUi] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const bottomRef = useRef(null);

  // No auto-start: user should type 'hi' to begin

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage(manualText) {
    const text = (manualText ?? input).trim();
    if (!text || loading) return;
    if (manualText === undefined) setInput('');
    const next = [...messages, { author: 'user', text }];
    setMessages(next);
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text })
      });
      const data = await res.json();
      setSessionId(data.sessionId || sessionId);
      setUi(data.ui || null);
      setShowPicker(false);
      setMessages([...next, { author: 'bot', text: data.reply }]);
    } catch (e) {
      setMessages([
        ...next,
        { author: 'bot', text: 'Error talking to server.' }
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className='container'>
      <div className='phone'>
        <div className='wa-notch' />
        <div className='wa-header'>
          <img
            className='wa-avatar-img'
            src='/amazon-pay-dp.png'
            alt='Amazon Pay'
          />
          <div className='wa-meta'>
            <div className='wa-title'>
              Amazon Pay Gift Card by Pine Labs
              <img
                className='wa-blue-tick'
                src='/blue-tick.png'
                alt='verified'
              />
            </div>
            <div className='wa-subtitle'>online</div>
          </div>
        </div>
        <div className='wa-chat'>
          {messages.length === 0 && (
            <div className='hint'>Type "hi" to start the gift card flow.</div>
          )}
          {messages.map((m, i) => (
            <MessageBubble key={i} author={m.author} text={m.text} />
          ))}
          <div ref={bottomRef} />
          {ui &&
            !showPicker &&
            ui.kind !== 'download' &&
            ui.kind !== 'downloads' && (
              <ActionBubble
                ui={ui}
                onOpen={(kind, payload) => {
                  const isStart =
                    kind === 'start' || payload?.options?.[0]?.id === 'start';
                  if (isStart) {
                    setUi(null);
                    sendMessage('start');
                  } else {
                    setShowPicker(true);
                  }
                }}
              />
            )}

          {ui?.kind === 'downloads' && !showPicker && (
            <DownloadsBubble
              items={ui.items}
              onContinue={() => sendMessage('continue')}
            />
          )}
          {ui?.kind === 'download' && !showPicker && (
            <DownloadsBubble
              items={[
                {
                  label: ui.label || 'Download',
                  url: ui.url || '/gst-invoice.pdf'
                }
              ]}
              onContinue={() => sendMessage('continue')}
            />
          )}
        </div>
        {ui?.kind === 'buyerTypeOptions' && showPicker && (
          <Modal
            title='Who are you buying for?'
            onClose={() => setShowPicker(false)}>
            <div className='option-grid'>
              {ui.options?.map(o => (
                <button
                  key={o.id}
                  className='option'
                  onClick={() => {
                    setShowPicker(false);
                    setUi(null);
                    sendMessage(o.id);
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          </Modal>
        )}

        {ui?.kind === 'options' && showPicker && (
          <Modal
            title={ui.title || 'Select an option'}
            onClose={() => setShowPicker(false)}>
            <div className='option-grid'>
              {ui.options?.map(o => (
                <button
                  key={o.id}
                  className='option'
                  onClick={() => {
                    setShowPicker(false);
                    setUi(null);
                    sendMessage(o.id);
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
          </Modal>
        )}

        {ui?.kind === 'bizLeadForm' && showPicker && (
          <Modal title='Business details' onClose={() => setShowPicker(false)}>
            <BizLeadForm
              onSubmit={data => {
                setShowPicker(false);
                setUi(null);
                // Send fields in sequence to backend
                (async () => {
                  await sendMessage(data.name);
                  await new Promise(r => setTimeout(r, 50));
                  await sendMessage(data.company);
                  await new Promise(r => setTimeout(r, 50));
                  await sendMessage(data.email);
                  await new Promise(r => setTimeout(r, 50));
                  await sendMessage(data.phone);
                  await new Promise(r => setTimeout(r, 50));
                  await sendMessage(data.gstin || 'skip');
                })();
              }}
            />
          </Modal>
        )}

        {ui?.kind === 'occasionOptions' && showPicker && (
          <Modal
            title='Select an occasion'
            onClose={() => setShowPicker(false)}>
            <div className='option-grid'>
              {ui.options?.map(o => (
                <button
                  key={o.id}
                  className='option'
                  onClick={() => {
                    setShowPicker(false);
                    setUi(null);
                    sendMessage(o.id);
                  }}>
                  {o.label}
                </button>
              ))}
            </div>
            <div className='muted small'>
              Choose "Other (custom)" to type your own.
            </div>
          </Modal>
        )}

        {ui?.kind === 'templatePicker' && showPicker && (
          <Modal title='Choose a template' onClose={() => setShowPicker(false)}>
            <div className='template-grid'>
              {ui.templates?.map(t => (
                <div
                  key={t.id}
                  className='template-card'
                  onClick={() => {
                    setShowPicker(false);
                    setUi(null);
                    sendMessage(`template:${t.id}`);
                  }}>
                  <img src={t.imageUrl} alt={t.label} />
                  <div className='template-label'>{t.label}</div>
                </div>
              ))}
            </div>
          </Modal>
        )}

        {ui?.kind === 'amountOptions' && showPicker && (
          <AmountModal
            ui={ui}
            onSelect={val => {
              setShowPicker(false);
              setUi(null);
              sendMessage(String(val));
            }}
            onClose={() => setShowPicker(false)}
          />
        )}

        {ui?.kind === 'confirm' && showPicker && (
          <Modal title='Confirm order' onClose={() => setShowPicker(false)}>
            {ui.details && (
              <div className='confirm-wrap'>
                {ui.details.templateImageUrl && (
                  <img
                    className='confirm-image'
                    src={ui.details.templateImageUrl}
                    alt={ui.details.templateLabel}
                  />
                )}
                <div className='confirm-list'>
                  <div>
                    <strong>Occasion:</strong> {ui.details.occasion}
                  </div>
                  <div>
                    <strong>Template:</strong> {ui.details.templateLabel}
                  </div>
                  <div>
                    <strong>Amount:</strong> ₹{ui.details.amount}
                  </div>
                  <div>
                    <strong>Recipient:</strong> {ui.details.recipientEmail}
                  </div>
                  <div>
                    <strong>Message:</strong>{' '}
                    {ui.details.personalMessage || '(none)'}
                  </div>
                </div>
              </div>
            )}
            <div className='button-row'>
              <button
                className='confirm'
                onClick={() => {
                  setShowPicker(false);
                  setUi(null);
                  sendMessage('confirm');
                }}>
                Confirm
              </button>
              <button
                className='cancel'
                onClick={() => {
                  setShowPicker(false);
                  setUi(null);
                  sendMessage('cancel');
                }}>
                Cancel
              </button>
            </div>
          </Modal>
        )}

        {ui?.kind === 'uploadPO' && showPicker && (
          <Modal
            title='Upload Purchase Order'
            onClose={() => setShowPicker(false)}>
            <div className='upload-box'>
              <div className='upload-icon'>📄</div>
              <div className='muted small'>Select a PDF file to upload</div>
              <div
                className='button-row'
                style={{ justifyContent: 'flex-end', marginTop: 10 }}>
                <button
                  className='confirm'
                  onClick={() => {
                    setShowPicker(false);
                    setUi(null);
                    sendMessage('po_uploaded.pdf');
                  }}>
                  Upload PDF
                </button>
              </div>
            </div>
          </Modal>
        )}

        {ui?.kind === 'payment' && showPicker && (
          <Modal
            title='Mock Payment Gateway'
            onClose={() => setShowPicker(false)}>
            <PaymentForm
              onSubmit={() => {
                setShowPicker(false);
                setUi(null);
                sendMessage('paid');
              }}
            />
          </Modal>
        )}

        {ui?.kind === 'download' && showPicker && (
          <Modal title='Invoice' onClose={() => setShowPicker(false)}>
            <div className='download-box'>
              <div className='pdf-preview'>📄</div>
              <a
                className='download-link'
                href={ui.url || '/invoice.pdf'}
                download>
                {ui.label || 'Download'}
              </a>
            </div>
          </Modal>
        )}

        <form
          className='wa-input-bar'
          onSubmit={e => {
            e.preventDefault();
            sendMessage();
          }}>
          <input
            type='text'
            placeholder='Type a message'
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button type='submit' disabled={!input.trim()}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className='overlay'>
      <div className='modal'>
        <div className='modal-header'>
          <div className='modal-title'>{title}</div>
          <button className='modal-close' onClick={onClose}>
            ×
          </button>
        </div>
        <div className='modal-body'>{children}</div>
      </div>
    </div>
  );
}

function AmountModal({ ui, onSelect, onClose }) {
  const [custom, setCustom] = useState('');
  function submitCustom() {
    const val = custom.trim();
    if (!val) return;
    onSelect(val);
  }
  return (
    <Modal title='Select amount' onClose={onClose}>
      <div className='option-grid'>
        {ui.options
          ?.filter(o => o.id !== 'custom')
          .map(o => (
            <button
              key={o.id}
              className='option'
              onClick={() => onSelect(o.id)}>
              {o.label}
            </button>
          ))}
      </div>
      <div className='custom-row'>
        <input
          type='number'
          min={500}
          placeholder='Enter custom amount (₹)'
          value={custom}
          onChange={e => setCustom(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') submitCustom();
          }}
        />
        <button onClick={submitCustom}>Submit</button>
      </div>
    </Modal>
  );
}

function BizLeadForm({ onSubmit }) {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [gstin, setGstin] = useState('');
  return (
    <form
      className='lead-form'
      onSubmit={e => {
        e.preventDefault();
        onSubmit({ name, company, email, phone, gstin });
      }}>
      <label>Full Name</label>
      <input value={name} onChange={e => setName(e.target.value)} required />
      <label>Company Name</label>
      <input
        value={company}
        onChange={e => setCompany(e.target.value)}
        required
      />
      <label>Official Email ID</label>
      <input
        type='email'
        value={email}
        onChange={e => setEmail(e.target.value)}
        required
      />
      <label>Phone Number</label>
      <input
        inputMode='numeric'
        value={phone}
        onChange={e => setPhone(e.target.value)}
        required
      />
      <label>Business GSTIN (optional)</label>
      <input
        value={gstin}
        onChange={e => setGstin(e.target.value)}
        placeholder='Type skip if not available'
      />
      <div
        className='button-row'
        style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className='confirm' type='submit'>
          Submit
        </button>
      </div>
    </form>
  );
}
function ActionBubble({ ui, onOpen }) {
  const inferredStart =
    ui.options && ui.options.length === 1 && ui.options[0].id === 'start';
  const label =
    ui.kind === 'start' || inferredStart
      ? 'Buy a Gift Card'
      : ui.kind === 'buyerTypeOptions'
      ? 'Choose buyer type'
      : ui.kind === 'options'
      ? ui.title || 'Choose option'
      : ui.kind === 'occasionOptions'
      ? 'Choose occasion'
      : ui.kind === 'templatePicker'
      ? 'Choose template'
      : ui.kind === 'amountOptions'
      ? 'Select amount'
      : ui.kind === 'confirm'
      ? 'Review & confirm'
      : (ui.options && ui.options[0]?.label) || 'Open';

  return (
    <div className='row left'>
      <div className='bubble bot'>
        <button className='action-button' onClick={() => onOpen(ui.kind, ui)}>
          Open • {label}
        </button>
      </div>
    </div>
  );
}

function PaymentForm({ onSubmit }) {
  const [method, setMethod] = useState('upi');
  const [input, setInput] = useState('');
  return (
    <form
      className='lead-form'
      onSubmit={e => {
        e.preventDefault();
        onSubmit({ method, input });
      }}>
      <label>Payment Method</label>
      <div className='option-grid'>
        <button
          type='button'
          className='option'
          onClick={() => setMethod('upi')}>
          UPI
        </button>
        <button
          type='button'
          className='option'
          onClick={() => setMethod('card')}>
          Card
        </button>
        <button
          type='button'
          className='option'
          onClick={() => setMethod('netbanking')}>
          Netbanking
        </button>
      </div>
      <label>
        {method === 'card'
          ? 'Card Number'
          : method === 'upi'
          ? 'UPI ID'
          : 'Account / Ref ID'}
      </label>
      <input value={input} onChange={e => setInput(e.target.value)} required />
      <div
        className='button-row'
        style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className='confirm' type='submit'>
          Pay Now
        </button>
      </div>
    </form>
  );
}

function DownloadsBubble({ items, onContinue }) {
  const list =
    Array.isArray(items) && items.length > 0
      ? items
      : [
          { label: 'GST Invoice (PDF)', url: '/gst-invoice.pdf' },
          { label: 'GC Delivery (PDF)', url: '/gc-delivery.pdf' },
          { label: 'PO (PDF)', url: '/po.pdf' }
        ];
  return (
    <div className='row left'>
      <div className='bubble bot'>
        <div className='file-chips'>
          {list.map((it, idx) => (
            <a key={idx} className='file-chip' href={it.url} download>
              📄 {it.label}
            </a>
          ))}
        </div>
        {onContinue && (
          <div className='button-row' style={{ marginTop: 8 }}>
            <button className='confirm' onClick={onContinue}>
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

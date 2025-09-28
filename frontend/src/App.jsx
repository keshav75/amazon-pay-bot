import React, { useEffect, useRef, useState } from 'react';

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || 'https://amazon-pay-bot.onrender.com';

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
                // Send single batch payload to backend to avoid multiple chat lines
                const payload = `lead|${data.name}|${data.company}|${
                  data.email
                }|${data.phone}|${data.gstin || 'skip'}`;
                sendMessage(payload);
              }}
            />
          </Modal>
        )}

        {ui?.kind === 'bizVerificationForm' && showPicker && (
          <Modal
            title='Business Verification'
            onClose={() => setShowPicker(false)}>
            <BizVerificationForm
              onSubmit={data => {
                setShowPicker(false);
                setUi(null);
                // Send single batch payload to backend to avoid multiple chat lines
                const payload = `lead|${data.fullName}|${data.company}|${data.phone}|${data.email}|${data.gstin}|${data.bankAccount}|${data.ifsc}`;
                sendMessage(payload);
              }}
            />
          </Modal>
        )}

        {ui?.kind === 'bizOrderForm' && showPicker && (
          <Modal title='Order Details' onClose={() => setShowPicker(false)}>
            <BizOrderForm
              onSubmit={data => {
                setShowPicker(false);
                setUi(null);
                // Send new format with multiple orders
                const payload = `orders|${JSON.stringify(data.orders)}|${
                  data.total
                }`;
                sendMessage(payload);
              }}
            />
          </Modal>
        )}

        {ui?.kind === 'bizDeliveryForm' && showPicker && (
          <Modal title='Delivery Email' onClose={() => setShowPicker(false)}>
            <BizDeliveryForm
              email={ui.email}
              onSubmit={data => {
                setShowPicker(false);
                setUi(null);
                sendMessage(data.email);
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

function BizVerificationForm({ onSubmit }) {
  const [fullName, setFullName] = useState('');
  const [company, setCompany] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [gstin, setGstin] = useState('');
  const [bankAccount, setBankAccount] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');

  const handleSubmit = e => {
    e.preventDefault();
    if (step === 1) {
      // Check for invalid GSTIN (4 or more zeros)
      const gstinZeros = (gstin || '').match(/0/g) || [];
      if (gstinZeros.length >= 4) {
        setError(
          'Cannot verify your business details. Please go back and enter correct details.'
        );
        setStep(3); // Error step
        return;
      }
      setStep(2);
    } else if (step === 2) {
      onSubmit({ fullName, company, phone, email, gstin, bankAccount, ifsc });
    }
  };

  if (step === 2) {
    return (
      <div style={{ padding: '20px' }}>
        <h3
          style={{
            margin: '0 0 20px 0',
            fontSize: '18px',
            fontWeight: '600'
            // color: '#333'
          }}>
          ✅ Successfully verified your business
        </h3>

        <div style={{ marginBottom: '16px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            Full Name:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{fullName}</span>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            Company Name:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{company}</span>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            Phone:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{phone}</span>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            Official E-mail Id:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{email}</span>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            Business GSTIN:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{gstin}</span>
        </div>

        <div style={{ marginBottom: '16px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            Bank Account:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{bankAccount}</span>
        </div>

        <div style={{ marginBottom: '20px' }}>
          <strong
            style={{
              fontSize: '14px',
              color: '#555',
              display: 'block',
              marginBottom: '4px'
            }}>
            IFSC Code:
          </strong>
          <span style={{ fontSize: '14px', color: '#333' }}>{ifsc}</span>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '12px'
          }}>
          <button
            type='button'
            onClick={() => setStep(1)}
            style={{
              padding: '10px 16px',
              border: '1px solid #ddd',
              borderRadius: '6px',
              backgroundColor: '#f8f9fa',
              color: '#333',
              cursor: 'pointer',
              fontSize: '14px'
            }}>
            ← Edit Details
          </button>
          <button
            onClick={handleSubmit}
            style={{
              padding: '10px 20px',
              border: 'none',
              borderRadius: '6px',
              backgroundColor: '#28a745',
              color: 'white',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500'
            }}>
            ✅ Confirm & Verify
          </button>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>❌</div>
          <h3
            style={{
              margin: '0 0 16px 0',
              fontSize: '18px',
              fontWeight: '600',
              color: '#dc3545'
            }}>
            Verification Failed
          </h3>
          <p
            style={{
              margin: '0 0 20px 0',
              fontSize: '14px',
              color: '#666',
              lineHeight: '1.5'
            }}>
            {error}
          </p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', gap: '12px' }}>
          <button
            type='button'
            onClick={() => {
              setStep(1);
              setError('');
            }}
            style={{
              padding: '10px 20px',
              border: 'none',
              borderRadius: '6px',
              backgroundColor: '#007bff',
              color: 'white',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: '500'
            }}>
            ← Go Back & Edit Details
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className='lead-form' onSubmit={handleSubmit}>
      <label>Full Name</label>
      <input
        value={fullName}
        onChange={e => setFullName(e.target.value)}
        placeholder='Enter your full name'
        required
      />
      <label>Company Name</label>
      <input
        value={company}
        onChange={e => setCompany(e.target.value)}
        placeholder='Enter company name'
        required
      />
      <label>Phone</label>
      <input
        type='tel'
        value={phone}
        onChange={e => setPhone(e.target.value)}
        placeholder='Enter phone number'
        required
      />
      <label>Official E-mail Id</label>
      <input
        type='email'
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder='Enter official email'
        required
      />
      <label>Business GSTIN</label>
      <input
        value={gstin}
        onChange={e => setGstin(e.target.value)}
        placeholder='Enter GSTIN'
        required
      />
      <label>Bank account</label>
      <input
        value={bankAccount}
        onChange={e => setBankAccount(e.target.value)}
        placeholder='Same as GST entity'
        required
      />
      <label>IFSC Code</label>
      <input
        value={ifsc}
        onChange={e => setIfsc(e.target.value.toUpperCase())}
        placeholder='Enter IFSC code'
        required
      />
      <div className='muted small' style={{ marginTop: 16, marginBottom: 8 }}>
        To enable bulk orders & GST‑invoicing safely, we verify your company
        details with a quick ₹2 deposit.{' '}
        <a
          href='#'
          onClick={e => e.preventDefault()}
          style={{ textDecoration: 'underline' }}>
          Know more
        </a>
      </div>
      <div
        className='button-row'
        style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className='confirm' type='submit'>
          ✅ Submit & Verify
        </button>
      </div>
    </form>
  );
}

function BizOrderForm({ onSubmit }) {
  const [orders, setOrders] = useState([{ denomination: '', count: '' }]);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState({});

  const calculateTotal = () => {
    const totalAmount = orders.reduce((sum, order) => {
      const denom = parseInt(order.denomination) || 0;
      const count = parseInt(order.count) || 0;
      return sum + denom * count;
    }, 0);
    setTotal(totalAmount);
  };

  useEffect(() => {
    calculateTotal();
  }, [orders]);

  const updateOrder = (index, field, value) => {
    const newOrders = [...orders];
    newOrders[index][field] = value;
    setOrders(newOrders);

    // Validate denomination
    if (field === 'denomination' && value) {
      const newErrors = { ...errors };
      const denom = parseInt(value);

      if (denom < 10) {
        newErrors[`${index}-denomination`] = 'Minimum denomination is ₹10';
      } else if (denom > 10000) {
        newErrors[`${index}-denomination`] = 'Maximum denomination is ₹10,000';
      } else {
        delete newErrors[`${index}-denomination`];
      }

      setErrors(newErrors);
    }
  };

  const addOrder = () => {
    if (orders.length < 5) {
      setOrders([...orders, { denomination: '', count: '' }]);
    }
  };

  const removeOrder = index => {
    if (orders.length > 1) {
      const newOrders = orders.filter((_, i) => i !== index);
      setOrders(newOrders);
    }
  };

  const handleSubmit = e => {
    e.preventDefault();
    if (total > 300000 || Object.keys(errors).length > 0) {
      return; // Don't submit if over limit or has validation errors
    }
    onSubmit({
      orders: orders.filter(order => order.denomination && order.count),
      total
    });
  };

  return (
    <div style={{ maxHeight: '70vh', overflowY: 'auto', padding: '4px' }}>
      <form className='lead-form' onSubmit={handleSubmit}>
        <h3
          style={{ margin: '0 0 16px 0', fontSize: '16px', fontWeight: '600' }}>
          Order Details
        </h3>

        {orders.map((order, index) => (
          <div
            key={index}
            style={{
              marginBottom: '16px',
              padding: '12px',
              border: '1px solid #ddd',
              borderRadius: '8px'
            }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '8px'
              }}>
              <span style={{ fontSize: '14px', fontWeight: '500' }}>
                Item {index + 1}
              </span>
              {orders.length > 1 && (
                <button
                  type='button'
                  onClick={() => removeOrder(index)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#dc3545',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}>
                  ✕ Remove
                </button>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '12px'
              }}>
              <div>
                <label
                  style={{
                    fontSize: '12px',
                    color: '#666',
                    display: 'block',
                    marginBottom: '4px'
                  }}>
                  Denomination (INR)
                </label>
                <input
                  type='number'
                  value={order.denomination}
                  onChange={e =>
                    updateOrder(index, 'denomination', e.target.value)
                  }
                  placeholder='₹ Amount'
                  min='10'
                  max='10000'
                  required
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: `1px solid ${
                      errors[`${index}-denomination`] ? '#dc3545' : '#ddd'
                    }`,
                    borderRadius: '4px'
                  }}
                />
                {errors[`${index}-denomination`] && (
                  <div
                    style={{
                      fontSize: '12px',
                      color: '#dc3545',
                      marginTop: '4px'
                    }}>
                    {errors[`${index}-denomination`]}
                  </div>
                )}
              </div>

              <div>
                <label
                  style={{
                    fontSize: '12px',
                    color: '#666',
                    display: 'block',
                    marginBottom: '4px'
                  }}>
                  Count
                </label>
                <input
                  type='number'
                  value={order.count}
                  onChange={e => updateOrder(index, 'count', e.target.value)}
                  placeholder='Quantity'
                  min='1'
                  required
                  style={{
                    width: '100%',
                    padding: '8px',
                    border: '1px solid #ddd',
                    borderRadius: '4px'
                  }}
                />
              </div>
            </div>

            {order.denomination && order.count && (
              <div
                style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                Subtotal: ₹
                {(
                  (parseInt(order.denomination) || 0) *
                  (parseInt(order.count) || 0)
                ).toLocaleString()}
              </div>
            )}
          </div>
        ))}

        {orders.length < 5 && (
          <button
            type='button'
            onClick={addOrder}
            style={{
              width: '100%',
              padding: '8px',
              border: '1px dashed #007bff',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: '#007bff',
              cursor: 'pointer',
              marginBottom: '16px',
              fontSize: '14px'
            }}>
            + Add Another Item
          </button>
        )}

        <div
          style={{
            padding: '12px',
            backgroundColor: total > 300000 ? '#fff3cd' : '#d4edda',
            borderRadius: '8px',
            marginBottom: '16px',
            border: `1px solid ${total > 300000 ? '#ffeaa7' : '#c3e6cb'}`
          }}>
          <div
            style={{
              fontSize: '16px',
              fontWeight: '600',
              marginBottom: '4px',
              color: '#dc3545'
            }}>
            Total Amount: ₹{total.toLocaleString()}
          </div>

          {total > 300000 ? (
            <div style={{ fontSize: '14px', color: '#856404' }}>
              ⚠️ Orders above ₹3,00,000 require special handling. Please contact
              customer care:{' '}
              <a
                href='tel:18000123456'
                style={{ color: '#007bff', textDecoration: 'underline' }}>
                180001 234567
              </a>
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: '#155724' }}>
              ✅ Order within limit
            </div>
          )}
        </div>

        <div
          className='button-row'
          style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button
            className='confirm'
            type='submit'
            disabled={
              total > 300000 || total === 0 || Object.keys(errors).length > 0
            }
            style={{
              opacity:
                total > 300000 || total === 0 || Object.keys(errors).length > 0
                  ? 0.6
                  : 1,
              cursor:
                total > 300000 || total === 0 || Object.keys(errors).length > 0
                  ? 'not-allowed'
                  : 'pointer'
            }}>
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}

function BizDeliveryForm({ email, onSubmit }) {
  const [deliveryEmail, setDeliveryEmail] = useState(email || '');
  const [isEditing, setIsEditing] = useState(false);

  return (
    <form
      className='lead-form'
      onSubmit={e => {
        e.preventDefault();
        onSubmit({ email: deliveryEmail });
      }}>
      <label>Delivery Email</label>
      {!isEditing ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            value={deliveryEmail}
            readOnly
            style={{ backgroundColor: '#f5f5f5' }}
          />
          <button
            type='button'
            onClick={() => setIsEditing(true)}
            className='option'
            style={{ margin: 0 }}>
            Edit Email
          </button>
        </div>
      ) : (
        <input
          type='email'
          value={deliveryEmail}
          onChange={e => setDeliveryEmail(e.target.value)}
          placeholder='Enter delivery email'
          required
        />
      )}
      <div
        className='button-row'
        style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className='confirm' type='submit'>
          Continue
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
          {ui.kind === 'bizVerificationForm' ? 'Proceed' : `Open • ${label}`}
        </button>
      </div>
    </div>
  );
}

function PaymentForm({ onSubmit }) {
  const [method, setMethod] = useState('neft');
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
          onClick={() => setMethod('neft')}>
          NEFT / Netbanking
        </button>
        <button
          type='button'
          className='option'
          onClick={() => setMethod('card')}>
          Credit Card
        </button>
      </div>
      <label>{method === 'card' ? 'Card Number' : 'Account / Ref ID'}</label>
      <input value={input} onChange={e => setInput(e.target.value)} required />
      <div className='muted small' style={{ marginTop: 8 }}>
        💳 Before completing your payment, please keep in mind:
        <br />
        1. Carefully review your PI to ensure all details are correct.
        <br />
        2. For bank transfers, use the same GST company account shared during
        verification.
        <br />
        3. You can also pay conveniently using a Credit Card.
      </div>
      <div
        className='button-row'
        style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className='confirm' type='submit'>
          ✅ I Understand & Pay Now
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

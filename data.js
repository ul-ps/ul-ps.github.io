/**
 * Accounting System Data & Logic Manager (v5)
 * Features: Customers, Prod Categories, Order Management (Cancel/Delete), Delivery/Discount
 */

// Firebase is loaded dynamically to avoid blocking the initial page render.
// This allows the sidebar + store to initialize immediately from localStorage.


const DB_KEY = 'accounting_sys_db_v5';
const CLOUD_SYNC_KEY = 'accounting_sys_cloud_doc'; // Firestore document ID

const INITIAL_DATA = {
    settings: {
        branding: {
            name: '🚀 المحاسب الذكي',
            logo: '' // Base64 string
        },
        currencies: [
            { code: 'ILS', symbol: '₪', name: 'شيكل' },
            { code: 'USD', symbol: '$', name: 'دولار' },
            { code: 'JOD', symbol: 'JD', name: 'دينار' }
        ],
        expenseCategories: ['إيجار', 'رواتب', 'كهرباء/ماء', 'صيانة', 'تسويق', 'ضيافة', 'بضاعة', 'نثريات'],
        productCategories: ['عام', 'خواتم', 'أساور', 'سلاسل', 'أطقم', 'هدايا'],
        deliveryZones: [
            { name: 'استلام (Pick-up)', price: 0 },
            { name: 'الضفة (West Bank)', price: 20 },
            { name: 'القدس (Jerusalem)', price: 30 },
            { name: 'الداخل (Inside 48)', price: 70 }
        ]
    },
    funds: {
        ILS: 0,
        USD: 0,
        JOD: 0
    },
    suppliers: [],
    customers: [],
    products: [],
    purchases: [],
    expenses: [],
    orders: [],
    transactions: [],
    employees: [],
    shipments: [],
    partnerLogs: []
};

/**
 * Firebase RTDB converts sparse JS arrays to objects with numeric string keys.
 * This safely restores only the KNOWN array fields back to proper JS arrays.
 */
function normalizeRTDB(data) {
    if (!data || typeof data !== 'object') return data;

    // Helper: convert RTDB numeric-key object to sorted array
    function toArray(val) {
        if (!val) return [];
        if (Array.isArray(val)) return val;
        if (typeof val === 'object') {
            return Object.keys(val)
                .sort((a, b) => Number(a) - Number(b))
                .map(k => val[k])
                .filter(v => v != null);
        }
        return [];
    }

    // Top-level arrays
    const ROOT_ARRAYS = ['products', 'orders', 'customers', 'expenses', 'purchases',
                         'employees', 'suppliers', 'transactions', 'shipments', 'partnerLogs'];

    // settings-nested arrays
    const SETTINGS_ARRAYS = ['currencies', 'deliveryZones', 'deliveryCompanies',
                              'expenseCategories', 'productCategories'];

    const result = { ...data };

    for (const key of ROOT_ARRAYS) {
        result[key] = toArray(result[key]);
    }

    if (result.settings && typeof result.settings === 'object') {
        result.settings = { ...result.settings };
        for (const key of SETTINGS_ARRAYS) {
            result.settings[key] = toArray(result.settings[key]);
        }
    }

    return result;
}

class AppStore {
    constructor() {
        this.data = this.load();
        this.migrate();
        this._pendingSync = false;  // flag: save() was called before Firebase ready
        this.initFirebase();
    }

    // Firebase is loaded dynamically to not block the initial UI render
    async initFirebase() {
        try {
            const firebaseConfig = {
                apiKey: "AIzaSyDi-ISQ_83WP6cQAFSpjlsxmqdV6i0Bel4",
                authDomain: "ulps-16b02.firebaseapp.com",
                databaseURL: "https://ulps-16b02-default-rtdb.firebaseio.com",
                projectId: "ulps-16b02",
                storageBucket: "ulps-16b02.firebasestorage.app",
                messagingSenderId: "28882791693",
                appId: "1:28882791693:web:1a7b9fa1bfedd24bc25444"
            };

            const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js");
            const { getDatabase, ref, set, get, onValue } = await import("https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js");

            this.app = initializeApp(firebaseConfig);
            this.rtdb = getDatabase(this.app);
            this.cloudRef = ref(this.rtdb, 'accounting/' + CLOUD_SYNC_KEY);
            this._dbSet = set;
            this._cloudRef = this.cloudRef;

            console.log('✅ Firebase Realtime Database Connected');

            // ── STEP 1: One-time read to check if cloud has newer data ──────
            const snapshot = await get(this.cloudRef);
            const rawCloudData = snapshot.val();
            const cloudData = rawCloudData ? normalizeRTDB(rawCloudData) : null;
            const localTimestamp = this.data.lastUpdated || 0;
            const cloudTimestamp = cloudData ? (cloudData.lastUpdated || 0) : 0;

            // Use !== instead of > to make it immune to clock skew between PC/Phone!
            // IMPORTANT: If _pendingSync is true, we have fresh un-synced local data (e.g. from migrate),
            // so we MUST NOT overwrite it with older cloud data!
            if (!this._pendingSync && cloudTimestamp && cloudTimestamp !== localTimestamp) {
                console.log('☁️ Cloud data differs — updating localStorage and reloading...');
                localStorage.setItem(DB_KEY, JSON.stringify(cloudData));
                location.reload();
                return;
            }

            // ── STEP 2: Flush any pending save from before Firebase was ready ──
            if (this._pendingSync) {
                console.log('☁️ Flushing pending sync...');
                this._pendingSync = false;
                this.syncToCloud();
            }

            // ── STEP 3: listen for live updates from other devices ───────────
            onValue(this.cloudRef, (snap) => {
                const rawLiveData = snap.val();
                if (!rawLiveData) return;
                const liveData = normalizeRTDB(rawLiveData);
                const liveTimestamp = liveData.lastUpdated || 0;
                if (liveTimestamp && liveTimestamp !== (this.data.lastUpdated || 0)) {
                    console.log('☁️ Live update differs from local — reloading...');
                    this.data = liveData;
                    localStorage.setItem(DB_KEY, JSON.stringify(this.data));
                    window.dispatchEvent(new CustomEvent('db-update', { detail: this.data }));
                    location.reload();
                }
            });

        } catch (e) {
            console.warn('⚠️ Firebase Init Error (running offline):', e.message);
        }
    }

    load() {
        const stored = localStorage.getItem(DB_KEY);
        if (stored) {
            try {
                return JSON.parse(stored);
            } catch(e) {
                console.error("Load Error:", e);
            }
        }
        return JSON.parse(JSON.stringify(INITIAL_DATA));
    }

    save() {
        this.data.lastUpdated = Date.now();
        localStorage.setItem(DB_KEY, JSON.stringify(this.data));
        this.syncToCloud();
    }

    async syncToCloud() {
        if (!this._dbSet || !this._cloudRef) {
            this._pendingSync = true;
            console.warn('☁️ Firebase not ready, queued for sync after connect');
            return;
        }
        try {
            const dataSize = JSON.stringify(this.data).length;
            console.log(`☁️ Syncing to RTDB... (${(dataSize/1024).toFixed(1)} KB)`);
            await this._dbSet(this._cloudRef, this.data);
            console.log('☁️ Cloud Sync OK ✅');
        } catch (e) {
            console.error('☁️ Cloud Sync FAILED ❌:', e.message);
            if (window.UI && UI.toast) {
                UI.toast('⚠️ فشل الحفظ السحابي: ' + e.message, 'danger');
            }
        }
    }

    migrate() {
        let modified = false;

        const checkArray = (key) => {
            if (!this.data[key]) { this.data[key] = []; modified = true; }
        };

        checkArray('customers');
        checkArray('employees');
        checkArray('shipments');
        checkArray('partnerLogs');

        if (!this.data.settings.branding) {
            this.data.settings.branding = JSON.parse(JSON.stringify(INITIAL_DATA.settings.branding));
            modified = true;
        }
        if (!this.data.settings.productCategories) {
            this.data.settings.productCategories = INITIAL_DATA.settings.productCategories;
            modified = true;
        }
        if (!this.data.settings.expenseCategories) {
            this.data.settings.expenseCategories = INITIAL_DATA.settings.expenseCategories;
            modified = true;
        }
        if (typeof this.data.settings.currencies === 'undefined') {
            this.data.settings.currencies = INITIAL_DATA.settings.currencies;
            modified = true;
        }
        if (typeof this.data.settings.orderSeq === 'undefined') {
            this.data.settings.orderSeq = this.data.orders.length;
            modified = true;
        }

        // Advanced Delivery Migration
        if (!this.data.settings.deliveryCompanies) {
            this.data.settings.deliveryCompanies = [];
            modified = true;
            // If old structure exists, migrate it
            if (this.data.settings.deliveryZones && this.data.settings.deliveryZones.length > 0) {
                this.data.settings.deliveryCompanies.push({
                    id: 'default-co',
                    name: 'شركة توصيل عامة',
                    areas: this.data.settings.deliveryZones.map(z => ({ name: z.name, price: z.price }))
                });
                delete this.data.settings.deliveryZones;
                modified = true;
            }
        }

        // Ensure products have category
        this.data.products.forEach(p => {
            if (!p.category) { p.category = 'عام'; modified = true; }
        });

        // Save old funds to check if recalculation changed them
        const oldFundsStr = JSON.stringify(this.data.funds);
        this.recalculateGlobalFunds();
        if (JSON.stringify(this.data.funds) !== oldFundsStr) {
            modified = true;
        }

        // Fix Legacy Statuses
        this.data.orders.forEach(o => {
            const inShipments = this.data.shipments.find(s => s.orderId === o.id);
            const isShipped = o.deliveryCompanyId || inShipments;

            // Fix: User explicitly wants Scheduled orders to be "Scheduled" even if they have a delivery company
            // Fix 3: Smart Migration for Courier items "stuck" as SCHEDULED
            // If it has a delivery company, we try to distinguish "In Delivery" vs "Future Scheduled".
            if (o.deliveryCompanyId && (o.status === 'SCHEDULED' || o.status === 'COMPLETED')) {
                const orderDate = new Date(o.date || o.createdAt);
                const now = new Date();
                // If it's in the future (tomorrow or later), it's truly SCHEDULED.
                // We add a small buffer (start of tomorrow) to treat "Today" as In Delivery.
                const startOfTomorrow = new Date(now);
                startOfTomorrow.setDate(now.getDate() + 1);
                startOfTomorrow.setHours(0, 0, 0, 0);

                if (orderDate >= startOfTomorrow) {
                    if (o.status !== 'SCHEDULED' || o.isScheduled !== true) {
                        o.status = 'SCHEDULED';
                        o.isScheduled = true;
                        modified = true;
                    }
                } else {
                    // If it's past/today, it's active IN_DELIVERY
                    // UNLESS the user explicitly set it? But legacy data is muddy. 
                    // This heuristic is the best best: Active Date + Courier = In Delivery.
                    o.isScheduled = false;
                }
            }
            // Fallback for legacy items without delivery company
            else if (o.status === 'COMPLETED' && (o.isScheduled === true || o.isScheduled === 'true')) {
                o.status = 'SCHEDULED';
            }
        });

        // Sync Shipments with Orders
        this.data.shipments.forEach(s => {
            const o = this.data.orders.find(ord => ord.id === s.orderId);
            if (o && s.status !== o.status) {
                s.status = o.status;
                modified = true;
            }
        });

        if (modified) {
            console.log("🛠️ Data migrated/fixed, saving...");
            this.save();
        }
    }

    recalculateGlobalFunds() {
        // 1. Reset all funds to 0
        this.getCurrencies().forEach(c => this.data.funds[c.code] = 0);

        // 2. Re-sum from transactions
        const txs = this.data.transactions || [];

        txs.forEach(tx => {
            const cur = tx.currency || 'ILS';
            const amt = parseFloat(tx.amount);

            // Safety check
            if (this.data.funds[cur] === undefined) this.data.funds[cur] = 0;

            if (tx.type === 'IN') {
                this.data.funds[cur] += amt;
            } else {
                this.data.funds[cur] -= amt;
            }
        });
        console.log('Funds recalculated:', this.data.funds);
    }

    // --- Settings ---
    getProductCategories() { return this.data.settings.productCategories; }

    addProductCategory(cat) {
        if (!this.data.settings.productCategories.includes(cat)) {
            this.data.settings.productCategories.push(cat);
            this.save();
        }
    }

    getDeliveryCompanies() { return this.data.settings.deliveryCompanies || []; }

    addDeliveryCompany(co) {
        co.id = Date.now().toString();
        if (!co.areas) co.areas = [];
        this.data.settings.deliveryCompanies.push(co);
        this.save();
    }

    updateDeliveryCompany(co) {
        const idx = this.data.settings.deliveryCompanies.findIndex(c => c.id === co.id);
        if (idx !== -1) {
            this.data.settings.deliveryCompanies[idx] = co;
            this.save();
        }
    }

    deleteDeliveryCompany(id) {
        this.data.settings.deliveryCompanies = this.data.settings.deliveryCompanies.filter(c => c.id !== id);
        this.save();
    }

    getBranding() {
        return this.data.settings.branding || INITIAL_DATA.settings.branding;
    }

    updateBranding(branding) {
        this.data.settings.branding = { ...this.getBranding(), ...branding };
        this.save();
    }

    // --- Employees ---
    getEmployees() { return this.data.employees || []; }

    addEmployee(emp) {
        emp.id = Date.now().toString();
        emp.createdAt = new Date().toISOString();
        if (!emp.partnerBalance) {
            emp.partnerBalance = {};
            this.getCurrencies().forEach(c => emp.partnerBalance[c.code] = 0);
        }
        this.data.employees.push(emp);
        this.save();
        return emp;
    }

    updateEmployee(emp) {
        const idx = this.data.employees.findIndex(e => e.id === emp.id);
        if (idx !== -1) {
            const old = this.data.employees[idx];
            const updated = { ...old, ...emp };

            // Initialize balance if missing
            if (!updated.partnerBalance) {
                updated.partnerBalance = {};
                this.getCurrencies().forEach(c => updated.partnerBalance[c.code] = 0);
            }

            this.data.employees[idx] = updated;
            this.save();
        }
    }

    deleteEmployee(id) {
        this.data.employees = this.data.employees.filter(e => e.id !== id);
        this.save();
    }

    updatePartnerBalance(empId, amount, currency, type, notes = '', skipTransaction = false) {
        const emp = this.data.employees.find(e => e.id === empId);
        if (!emp) throw new Error("Employee not found");

        if (!emp.partnerBalance) emp.partnerBalance = {};
        const amt = parseFloat(amount);
        const cur = currency || 'ILS';

        if (type === 'INVESTMENT') {
            // Partner gives money / repays loan.
            emp.partnerBalance[cur] = (emp.partnerBalance[cur] || 0) + amt;

            if (!skipTransaction) {
                // Now using addExpense for better visibility in Fund Movement list
                const exp = {
                    type: 'INCOME',
                    category: 'إيداع / استثمار / سداد من موظف',
                    amount: amt,
                    currency: cur,
                    notes: notes,
                    partnerId: empId,
                    date: new Date().toISOString()
                };
                // addExpense will call updatePartnerBalance again with skipTransaction = true
                this.addExpense(exp);
            }
        } else if (type === 'PAYOUT') {
            // Company gives money / partner withdraws.
            emp.partnerBalance[cur] = (emp.partnerBalance[cur] || 0) - amt;

            if (!skipTransaction) {
                const exp = {
                    type: 'EXPENSE',
                    category: 'سحب / سلفة / سداد لموظف',
                    amount: amt,
                    currency: cur,
                    notes: notes,
                    partnerId: empId,
                    date: new Date().toISOString()
                };
                this.addExpense(exp);
            }
        }

        // If skipTransaction is true, it means we were called FROM addExpense,
        // or we are doing a manual "out of pocket" update which doesn't touch cash.
        if (skipTransaction) {
            const logEntry = {
                id: Date.now().toString() + Math.random().toString().substr(2, 3),
                empId: empId,
                amount: amt,
                currency: cur,
                type: type,
                notes: notes,
                date: new Date().toISOString()
            };
            this.data.partnerLogs.unshift(logEntry);
            this.save();
            return logEntry;
        }

        return null;
    }

    getPartnerHistory(empId) {
        return this.data.partnerLogs.filter(log => log.empId === empId).sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    deletePartnerLog(logId) {
        const idx = this.data.partnerLogs.findIndex(l => l.id === logId);
        if (idx === -1) return;

        const log = this.data.partnerLogs[idx];
        const emp = this.data.employees.find(e => e.id === log.empId);

        // 1. Reverse Balance Impact
        if (emp && emp.partnerBalance) {
            const amt = parseFloat(log.amount);
            const cur = log.currency;
            if (log.type === 'INVESTMENT') {
                emp.partnerBalance[cur] = (emp.partnerBalance[cur] || 0) - amt;
            } else if (log.type === 'PAYOUT') {
                emp.partnerBalance[cur] = (emp.partnerBalance[cur] || 0) + amt;
            }
        }

        // 2. Delete linked Transaction
        if (log.txId) {
            this.deleteTransactionById(log.txId);
        }

        this.data.partnerLogs.splice(idx, 1);
        this.save();
    }

    recalculateBalancesFromHistory() {
        // Reset everyone's balance to 0
        this.data.employees.forEach(e => {
            e.partnerBalance = {};
            this.getCurrencies().forEach(c => e.partnerBalance[c.code] = 0);
        });

        // 1. Identify valid transaction IDs from logs
        const logTxIds = new Set(this.data.partnerLogs.filter(l => l.txId).map(l => l.txId));

        // 2. Clean transactions that look like partner movements but aren't in logs
        // This handles cases where a log was deleted but the transaction stayed
        this.data.transactions = this.data.transactions.filter(tx => {
            const isPartnerTx = tx.description.includes('سداد/سحب شريك:') ||
                tx.description.includes('استثمار/سداد من شريك:') ||
                tx.category === 'إيداع / استثمار / سداد من موظف' ||
                tx.category === 'سحب / سلفة / سداد لموظف' ||
                tx.category === 'سداد مستحقات شريك' ||
                tx.category === 'إيداع / استثمار من شريك';

            if (!isPartnerTx) return true;

            // If it's a partner tx, keep it only if its ID is in our valid logs set
            if (tx.id && logTxIds.has(tx.id)) return true;

            // If it's an orphan (old or inconsistent), remove it and reverse funds
            const amt = parseFloat(tx.amount);
            const cur = tx.currency || 'ILS';
            if (tx.type === 'IN') {
                this.data.funds[cur] -= amt;
            } else {
                this.data.funds[cur] += amt;
            }
            return false;
        });

        // 3. Re-apply every log entry chronologically to rebuild balances
        const logs = [...this.data.partnerLogs].sort((a, b) => new Date(a.date) - new Date(b.date));
        logs.forEach(l => {
            const emp = this.data.employees.find(e => e.id === l.empId);
            if (!emp) return;
            const amt = parseFloat(l.amount);
            const cur = l.currency;
            if (l.type === 'INVESTMENT') {
                emp.partnerBalance[cur] = (emp.partnerBalance[cur] || 0) + amt;
            } else if (l.type === 'PAYOUT') {
                emp.partnerBalance[cur] = (emp.partnerBalance[cur] || 0) - amt;
            }
        });

        this.save();
    }

    // --- Customers ---
    getCustomers() { return this.data.customers; }

    addCustomer(cust) {
        cust.id = Date.now().toString();
        cust.createdAt = new Date().toISOString();
        this.data.customers.push(cust);
        this.save();
        return cust;
    }

    // --- Products ---
    getProducts() { return this.data.products; }

    addProduct(prod) {
        if (!prod.id) prod.id = Date.now().toString();
        prod.createdAt = new Date().toISOString();
        if (!prod.image) prod.image = '';
        if (!prod.category) prod.category = 'عام';
        if (!prod.stock) prod.stock = 0; // Default stock
        this.data.products.push(prod);
        this.save();
    }

    updateProduct(oldId, prod) {
        const idToFind = oldId || prod.id;
        const idx = this.data.products.findIndex(p => p.id === idToFind);
        if (idx !== -1) {
            // Merge existing to keep created date etc, but overwrite fields
            this.data.products[idx] = { ...this.data.products[idx], ...prod };
            this.save();
        }
    }

    deleteProduct(id) {
        this.data.products = this.data.products.filter(p => p.id !== id);
        this.save();
    }

    // --- Orders & Transactions ---
    addTransaction(tx) {
        tx.id = Date.now().toString() + Math.random().toString().substr(2, 5);
        tx.date = tx.date || new Date().toISOString();
        const currency = tx.currency || 'ILS';
        const amount = parseFloat(tx.amount);

        if (this.data.funds[currency] === undefined) this.data.funds[currency] = 0;

        if (tx.type === 'IN') {
            this.data.funds[currency] += amount;
        } else {
            this.data.funds[currency] -= amount;
        }

        this.data.transactions.unshift(tx);
        this.save();
        return tx.id;
    }

    addOrder(data) {
        /* data: { customerName, customerId, currency, itemsText, cartItems:[{name, price}], 
                   subtotal, delivery, discount, total, notes, replaceId } */

        // 1. Handle Replacement if replaceId exists
        if (data.replaceId) {
            const oldIndex = this.data.orders.findIndex(o => o.id === data.replaceId);
            if (oldIndex !== -1) {
                // Remove old transactions linked to this order
                this.data.transactions = this.data.transactions.filter(t => t.relatedId !== data.replaceId);
                // Remove the old order
                this.data.orders.splice(oldIndex, 1);
            }
        }

        // Bug Fix: Any order with a delivery company is automatically "Scheduled" (Awaiting)
        // because funds are not received until delivery is confirmed.
        const isEffectiveScheduled = data.isScheduled || !!data.deliveryCompanyId;

        // Initialize sequence if missing
        if (!this.data.settings.orderSeq) this.data.settings.orderSeq = 0;

        let finalId = data.replaceId;
        if (!finalId) {
            this.data.settings.orderSeq++;
            finalId = 'A-' + this.data.settings.orderSeq;
        }

        const initialStatus = data.deliveryCompanyId ? 'IN_DELIVERY' : (data.isScheduled ? 'SCHEDULED' : 'COMPLETED');

        const order = {
            id: finalId,
            ...data,
            status: initialStatus,
            // Fix: Store explicit user intent. Implicit scheduling (Couriers) is handled by status/deliveryCompanyId checks.
            isScheduled: data.isScheduled || false,
            createdAt: data.createdAt || new Date().toISOString()
        };
        // Remove replaceId from the saved object
        delete order.replaceId;

        this.data.orders.push(order);

        // Reduce Stock
        if (data.cartItems) {
            data.cartItems.forEach(item => {
                const prod = this.data.products.find(p => p.name === item.name);
                if (prod) {
                    prod.stock = Math.max(0, (prod.stock || 0) - 1);
                }
            });
        }

        // Shipment Log
        if (data.deliveryCompanyId) {
            this.data.shipments.unshift({
                id: 'SHIP-' + Date.now(),
                orderId: order.id,
                customerName: data.customerName,
                companyId: data.deliveryCompanyId,
                companyName: data.deliveryCompanyName,
                areaName: data.deliveryAreaName,
                price: parseFloat(data.delivery || 0),
                date: order.createdAt,
                status: order.status
            });
        }

        // Only add transaction if NOT scheduled (i.e. it's an immediate cash sale)
        if (!isEffectiveScheduled) {
            const netAmount = parseFloat(data.total) - parseFloat(data.delivery || 0);
            if (netAmount > 0) {
                this.addTransaction({
                    type: 'IN',
                    category: 'SALE',
                    amount: netAmount,
                    currency: data.currency,
                    description: `طلب (${data.customerName})`,
                    relatedId: order.id,
                    date: new Date().toISOString()
                });
            }
        }

        this.save();
        return order;
    }

    // Unified Status & Financial Logic
    updateOrderStatus(orderId, newStatus) {
        const order = this.data.orders.find(o => o.id === orderId);
        if (!order) throw new Error("Order not found");

        // Cannot change if already cancelled (unless we implement "Restore", but let's keep it simple)
        if (order.status === 'CANCELLED' && newStatus !== 'CANCELLED') {
            // throw new Error("Cannot change status of a cancelled order");
        }

        const wasUnpaid = order.isScheduled || order.status === 'IN_DELIVERY';

        if (newStatus === 'DELIVERED') {
            // Add funds if not already added
            if (wasUnpaid) {
                const netAmount = parseFloat(order.total) - parseFloat(order.delivery || 0);
                if (netAmount > 0) {
                    this.addTransaction({
                        type: 'IN',
                        category: 'SALE',
                        amount: netAmount,
                        currency: order.currency,
                        description: `وصول طرد: (${order.customerName})`,
                        relatedId: order.id,
                        date: new Date().toISOString()
                    });
                }
                order.isScheduled = false; // Clear flag
            }
            order.status = 'DELIVERED';
        }
        else if (newStatus === 'IN_DELIVERY') {
            // Reversal Logic: If it WASN'T unpaid (i.e. was COMPLETED/Paid), reverse funds.
            if (!wasUnpaid) {
                const netAmount = parseFloat(order.total) - parseFloat(order.delivery || 0);
                if (netAmount > 0) {
                    this.addTransaction({
                        type: 'OUT',
                        category: 'INTERNAL',
                        amount: netAmount,
                        currency: order.currency,
                        description: `تعديل: تأجيل تحصيل مبلغ طلب (${order.customerName}) - جارٍ التوصيل`,
                        relatedId: order.id,
                        date: new Date().toISOString()
                    });
                }
                // Do NOT force isScheduled = true. IN_DELIVERY status is sufficient to imply unpaid.
            }
            order.status = 'IN_DELIVERY';
        }
        else if (newStatus === 'RETURNED') {
            if (order.status === 'RETURNED') return;

            // Reverse funds only if NOT unpaid (meaning they were added)
            if (!wasUnpaid) {
                const netAmount = parseFloat(order.total) - parseFloat(order.delivery || 0);
                if (netAmount > 0) {
                    this.addTransaction({
                        type: 'OUT',
                        category: 'RETURN',
                        amount: netAmount,
                        currency: order.currency,
                        description: `إرجاع طلب ${order.customerName}`,
                        relatedId: order.id,
                        date: new Date().toISOString()
                    });
                }
            }

            // Return Stock
            if (order.cartItems) {
                order.cartItems.forEach(item => {
                    const prod = this.data.products.find(p => p.name === item.name);
                    if (prod) prod.stock = (prod.stock || 0) + 1;
                });
            }
            order.status = 'RETURNED';
            order.isScheduled = false;
        }
        else if (newStatus === 'CANCELLED') {
            if (order.status === 'CANCELLED') return;

            // Reverse Transaction only if funds were added
            if (!wasUnpaid) {
                const netAmount = parseFloat(order.total) - parseFloat(order.delivery || 0);
                if (netAmount > 0) {
                    this.addTransaction({
                        type: 'OUT',
                        category: 'REFUND',
                        amount: netAmount,
                        currency: order.currency,
                        description: `إلغاء طلب ${order.customerName}`,
                        relatedId: order.id,
                        date: new Date().toISOString()
                    });
                }
            }
            // Return Stock
            if (order.cartItems) {
                order.cartItems.forEach(item => {
                    const prod = this.data.products.find(p => p.name === item.name);
                    if (prod) prod.stock = (prod.stock || 0) + 1;
                });
            }
            order.status = 'CANCELLED';
            order.isScheduled = false;
        }
        else if (newStatus === 'SCHEDULED') {
            order.isScheduled = true;
            order.status = 'SCHEDULED';
        }

        // Sync with Shipments
        const shipment = this.data.shipments.find(s => s.orderId === orderId);
        if (shipment) {
            shipment.status = order.status;
        }

        this.save();
    }

    // Legacy wrappers
    completeOrder(orderId) { this.updateOrderStatus(orderId, 'DELIVERED'); }
    returnOrder(orderId) { this.updateOrderStatus(orderId, 'RETURNED'); }
    cancelOrder(orderId) { this.updateOrderStatus(orderId, 'CANCELLED'); }

    // Permanent Delete (For Cancelled Orders Only)
    deleteOrder(orderId) {
        const order = this.data.orders.find(o => o.id === orderId);
        if (!order) throw new Error("Order not found");
        if (order.status !== 'CANCELLED' && order.status !== 'RETURNED') throw new Error("Only cancelled or returned orders can be deleted");

        // 1. Remove ALL related transactions (Sale & Refund)
        // We filter out any transaction linked to this order
        this.data.transactions = this.data.transactions.filter(t => t.relatedId !== orderId);

        // Note: We do NOT need to reverse funds again because:
        // - The Sale added funds (+X)
        // - The Cancel (Refund) removed funds (-X)
        // - Net impact is 0. So just removing the records is safe.

        // 2. Remove the Order
        this.data.orders = this.data.orders.filter(o => o.id !== orderId);
        this.save();
    }

    // --- History Helpers ---
    getTransactions() {
        return this.data.transactions || [];
    }

    getOrders() {
        return this.data.orders || [];
    }

    getCustomerHistory(custId) {
        return this.data.orders.filter(o => o.customerId === custId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    getSupplierHistory(supId) {
        return this.data.purchases.filter(p => p.supplierId === supId).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // --- Other Wrappers (Purchases, Suppliers etc same as V4) ---
    getCurrencies() { return this.data.settings.currencies; }
    addCurrency(cur) {
        if (!this.data.settings.currencies.find(c => c.code === cur.code)) {
            this.data.settings.currencies.push(cur);
            this.data.funds[cur.code] = 0;
            this.save();
        }
    }
    getExpenseCategories() { return this.data.settings.expenseCategories; }
    addExpenseCategory(cat) {
        if (!this.data.settings.expenseCategories.includes(cat)) {
            this.data.settings.expenseCategories.push(cat);
            this.save();
        }
    }
    removeExpenseCategory(cat) {
        this.data.settings.expenseCategories = this.data.settings.expenseCategories.filter(c => c !== cat);
        this.save();
    }
    getSuppliers() { return this.data.suppliers; }
    addSupplier(supplier) {
        supplier.id = Date.now().toString();
        supplier.balance = {};
        this.getCurrencies().forEach(c => supplier.balance[c.code] = 0);
        supplier.createdAt = new Date().toISOString();
        this.data.suppliers.push(supplier);
        this.save();
        return supplier;
    }

    updateSupplier(data) {
        const idx = this.data.suppliers.findIndex(s => s.id === data.id);
        if (idx !== -1) {
            this.data.suppliers[idx] = { ...this.data.suppliers[idx], ...data };
            this.save();
        }
    }

    deleteSupplier(id) {
        this.data.suppliers = this.data.suppliers.filter(s => s.id !== id);
        this.save();
    }

    addPurchase(data) {
        const supplier = this.data.suppliers.find(s => s.id === data.supplierId);
        if (!supplier) throw new Error("Supplier not found");
        if (!supplier.balance) supplier.balance = {};
        const cur = data.currency;
        const amt = parseFloat(data.amount);

        // Always increase supplier balance (inventory/stock logic usually implies we owe/paid for this)
        supplier.balance[cur] = (supplier.balance[cur] || 0) + amt;

        const purchaseId = 'PUR-' + Date.now();
        this.data.purchases.push({
            id: purchaseId,
            ...data,
            createdAt: new Date().toISOString()
        });

        // Only add transaction if PAID (Cash/Immediate)
        if (data.isPaid !== false) {
            this.addTransaction({
                type: 'OUT',
                category: 'PURCHASE',
                amount: amt,
                currency: cur,
                description: `شراء نقدي: ${supplier.name} - ${data.notes || ''}`,
                date: data.date,
                relatedId: purchaseId
            });
        }
    }

    paySupplier(supId, amount, currency, notes = '') {
        const supplier = this.data.suppliers.find(s => s.id === supId);
        if (!supplier) throw new Error("Supplier not found");

        const amt = parseFloat(amount);
        const cur = currency || 'ILS';

        if (!supplier.balance) supplier.balance = {};
        supplier.balance[cur] = (supplier.balance[cur] || 0) - amt;

        this.addTransaction({
            type: 'OUT',
            category: 'PURCHASE',
            amount: amt,
            currency: cur,
            description: `تسديد دفعة للمورد: ${supplier.name} ${notes ? '- ' + notes : ''}`,
            date: new Date().toISOString()
        });
        this.save();
    }

    cancelOrder(id) {
        this.updateOrderStatus(id, 'CANCELLED');
    }

    deletePurchase(id) {
        const purchase = this.data.purchases.find(p => p.id === id);
        if (!purchase) throw new Error("Purchase not found");

        // Reverse Supplier Balance
        const supplier = this.data.suppliers.find(s => s.id === purchase.supplierId);
        if (supplier && supplier.balance) {
            const cur = purchase.currency || 'ILS';
            supplier.balance[cur] = (supplier.balance[cur] || 0) - parseFloat(purchase.amount);
        }

        // Reverse Transaction (Fund Refund)
        this.deleteTransactionByRelatedId(id, purchase.amount, purchase.currency, 'OUT');

        // Remove from list
        this.data.purchases = this.data.purchases.filter(p => p.id !== id);
        this.save();
    }

    addExpense(data) {
        const type = data.type || 'EXPENSE';
        const txType = type === 'INCOME' ? 'IN' : 'OUT';
        const expId = 'EXP-' + Date.now();

        let logId = null;
        // Handle Partner Link (Income or Expense)
        if (data.partnerId) {
            const partnerAction = (type === 'INCOME') ? 'INVESTMENT' : 'PAYOUT';
            const logEntry = this.updatePartnerBalance(data.partnerId, data.amount, data.currency, partnerAction, data.notes, true);
            logId = logEntry.id;
        }

        const expObj = { id: expId, ...data, partnerLogId: logId, createdAt: new Date().toISOString() };
        this.data.expenses.push(expObj);

        this.addTransaction({
            type: txType,
            category: type,
            amount: parseFloat(data.amount),
            currency: data.currency,
            description: `${data.category}: ${data.notes || ''}`,
            date: data.date,
            relatedId: expId // Link
        });
    }

    deleteExpense(id) {
        const expense = this.data.expenses.find(e => e.id === id);
        if (!expense) throw new Error("Expense not found");

        const type = expense.type || 'EXPENSE';
        const txType = type === 'INCOME' ? 'IN' : 'OUT';

        // 1. If linked to a partner, reverse balance (via log deletion)
        if (expense.partnerLogId) {
            this.deletePartnerLog(expense.partnerLogId);
        } else if (expense.partnerId) {
            // Fallback for older records: manually reverse balance
            this.updatePartnerBalance(expense.partnerId, expense.amount, expense.currency, (type === 'INCOME' ? 'PAYOUT' : 'INVESTMENT'), 'تصحيح تلقائي لحذف مصروف', true);
        }

        // 2. Reverse Transaction
        this.deleteTransactionByRelatedId(id, expense.amount, expense.currency, txType);

        // 3. Remove from list
        this.data.expenses = this.data.expenses.filter(e => e.id !== id);
        this.save();
    }

    // New Helper: Delete Transaction & Reverse Funds
    deleteTransactionByRelatedId(relId, amount, currency, originalType) {
        // ... (existing logic) ...
        // 1. Remove from transactions list
        this.data.transactions = this.data.transactions.filter(t => t.relatedId !== relId);

        // 2. Reverse Fund Impact
        const amt = parseFloat(amount);
        const cur = currency || 'ILS';
        if (this.data.funds[cur] === undefined) this.data.funds[cur] = 0;

        if (originalType === 'IN') {
            this.data.funds[cur] -= amt;
        } else {
            this.data.funds[cur] += amt;
        }
        this.save();
    }

    deleteTransactionById(txId) {
        const idx = this.data.transactions.findIndex(t => t.id === txId);
        if (idx === -1) return;

        const tx = this.data.transactions[idx];
        const amt = parseFloat(tx.amount);
        const cur = tx.currency || 'ILS';

        // Reverse Funds
        if (this.data.funds[cur] === undefined) this.data.funds[cur] = 0;
        if (tx.type === 'IN') {
            this.data.funds[cur] -= amt;
        } else {
            this.data.funds[cur] += amt;
        }

        // Remove
        this.data.transactions.splice(idx, 1);
        this.save();
    }

    // --- Backup & Restore ---
    exportData() {
        const dataStr = JSON.stringify(this.data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `backup_accounting_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    importData(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const importedData = JSON.parse(e.target.result);
                // Basic validation: check if it has settings and at least one core array
                if (importedData.settings && importedData.orders && importedData.products) {
                    UI.confirm('⚠️ هل أنت متأكد؟ سيتم استبدال البيانات الحالية بالكامل بالبيانات المستوردة!', 'استيراد البيانات', () => {
                        this.data = importedData;
                        this.save();
                        location.reload();
                    });
                } else {
                    UI.alert('الملف المختار غير صالح أو بتنسيق خاطئ.', 'خطأ في الاستيراد');
                }
            } catch (err) {
                console.error(err);
                UI.alert('فشل في قراءة الملف. تأكد أنه ملف JSON صالح.', 'خطأ');
            }
        };
        reader.readAsText(file);
    }
}

// UI Helpers
const UI = {
    init: () => {
        UI.injectSidebar();
        UI.injectConfirmModal();
        UI.injectToastContainer();
    },

    getItemImage: (itemName, itemData) => {
        const name = itemName || itemData?.name || itemData?.productName || '';
        if (!name) return '';
        
        // Comprehensive name cleaning
        let cleanName = name.replace(/\s*\(\d+x\)\s*$/i, '').replace(/\s*\(\d+\)\s*$/i, '').trim().toLowerCase();
        
        // Priority 1: Direct Image from item data (if stored at time of order)
        let img = itemData?.image || itemData?.img || itemData?.itemImage;
        if (img && img !== 'undefined' && img !== 'null' && img.length > 5) return img;

        // Priority 2: Product List Lookup
        const products = store.getProducts();
        
        // 2a: Precise match
        let p = products.find(prod => (prod.name || '').trim().toLowerCase() === cleanName);
        
        // 2b: Fuzzy match
        if (!p) {
            p = products.find(prod => {
                const pName = (prod.name || '').trim().toLowerCase();
                return pName.includes(cleanName) || cleanName.includes(pName);
            });
        }

        // 2c: Last resort - try matching based on the first part of the name
        if (!p && cleanName.length > 3) {
            const firstPart = cleanName.split(' ')[0];
            if (firstPart.length > 3) {
                p = products.find(prod => (prod.name || '').trim().toLowerCase().startsWith(firstPart));
            }
        }

        return p?.image || p?.img || '';
    },

    injectToastContainer: () => {
        if (!document.querySelector('.toast-container')) {
            const container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
    },

    toast: (msg, type = 'success') => {
        const container = document.querySelector('.toast-container');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icons = {
            success: '<i class="fa-solid fa-circle-check"></i>',
            danger: '<i class="fa-solid fa-circle-xmark"></i>',
            warning: '<i class="fa-solid fa-triangle-exclamation"></i>',
            info: '<i class="fa-solid fa-circle-info"></i>'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
            <span class="toast-msg">${msg}</span>
        `;

        container.appendChild(toast);

        // Animate In
        setTimeout(() => toast.classList.add('active'), 10);

        // Auto Remove
        setTimeout(() => {
            toast.classList.remove('active');
            setTimeout(() => toast.remove(), 400);
        }, 3500);
    },

    injectConfirmModal: () => {
        if (!document.querySelector('.confirm-modal-overlay')) {
            const modal = document.createElement('div');
            modal.className = 'confirm-modal-overlay';
            modal.id = 'ui-confirm-modal';
            modal.innerHTML = `
                <div class="confirm-box">
                    <span class="confirm-icon" id="confirm-icon"><i class="fa-solid fa-circle-question"></i></span>
                    <div class="confirm-title" id="confirm-title">تأكيد الإجراء</div>
                    <div class="confirm-msg" id="confirm-msg">هل أنت متأكد؟</div>
                    <div class="confirm-actions">
                        <button class="btn-confirm-no" onclick="UI.closeConfirm()">إلغاء</button>
                        <button class="btn-confirm-yes" id="confirm-yes-btn">نعم، متأكد</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
    },

    confirm: (msg, title = 'تأكيد', onYes) => {
        const modal = document.getElementById('ui-confirm-modal');
        const msgEl = document.getElementById('confirm-msg');
        const titleEl = document.getElementById('confirm-title');
        const yesBtn = document.getElementById('confirm-yes-btn');
        const iconEl = document.getElementById('confirm-icon');

        msgEl.innerHTML = msg;
        titleEl.textContent = title;

        // Auto Icon Logic
        if (title.includes('حذف') || title.includes('إلغاء')) iconEl.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        else if (title.includes('تعديل')) iconEl.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
        else iconEl.innerHTML = '<i class="fa-solid fa-circle-question"></i>';

        // Reset Clone to remove old listeners
        const newYes = yesBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);

        newYes.onclick = () => {
            onYes();
            UI.closeConfirm();
        };

        modal.classList.add('active');
    },

    closeConfirm: () => {
        document.getElementById('ui-confirm-modal').classList.remove('active');
    },

    alert: (msg, title = 'تنبيه', onOk = null) => {
        // We can reuse the confirm modal structure for a simple alert
        const modal = document.getElementById('ui-confirm-modal');
        const msgEl = document.getElementById('confirm-msg');
        const titleEl = document.getElementById('confirm-title');
        const yesBtn = document.getElementById('confirm-yes-btn');
        const noBtn = document.querySelector('.btn-confirm-no');
        const iconEl = document.getElementById('confirm-icon');

        if (msgEl) msgEl.innerHTML = msg;
        if (titleEl) titleEl.textContent = title;
        if (iconEl) iconEl.innerHTML = '<i class="fa-solid fa-circle-info"></i>';

        if (noBtn) noBtn.style.display = 'none'; // Hide cancel button for alerts

        // Reset Clone to remove old listeners
        const newYes = yesBtn.cloneNode(true);
        yesBtn.parentNode.replaceChild(newYes, yesBtn);
        newYes.textContent = 'حسناً';

        newYes.onclick = () => {
            if (noBtn) noBtn.style.display = 'inline-block';
            UI.closeConfirm();
            if (onOk) onOk();
        };

        modal.classList.add('active');
    },

    injectSidebar: () => {
        const brand = store.getBranding();
        const logoHtml = brand.logo
            ? `<img src="${brand.logo}" style="height:80px; width:auto; max-width:220px; margin-bottom:15px; border-radius:12px; object-fit:contain;">`
            : '';
        const nameHtml = !brand.logo ? `<div style="font-size: 1.25rem;">${brand.name}</div>` : '';

        const sidebarHTML = `
            <div class="sidebar-header" style="flex-direction:column; height:auto; padding:15px 10px;">
                ${logoHtml}
                ${nameHtml}
            </div>
            <ul class="sidebar-menu">
                <li><a href="index.html" class="${UI.isActive('index.html')}"><i class="fa-solid fa-chart-pie"></i> لوحة التحكم</a></li>
                <li><a href="orders.html" class="${UI.isActive('orders.html')}"><i class="fa-solid fa-shopping-cart"></i> نقطة البيع (POS)</a></li>
                <li><a href="all_orders.html" class="${UI.isActive('all_orders.html')}"><i class="fa-solid fa-file-invoice"></i> سجل الطلبات</a></li>
                <li><a href="products.html" class="${UI.isActive('products.html')}"><i class="fa-solid fa-boxes-stacked"></i> المخزون / المنتجات</a></li>
                <li><a href="customers.html" class="${UI.isActive('customers.html')}"><i class="fa-solid fa-users"></i> العملاء</a></li>
                <li><a href="employees.html" class="${UI.isActive('employees.html')}"><i class="fa-solid fa-user-tie"></i> الموظفين</a></li>
                <li><a href="shipments.html" class="${UI.isActive('shipments.html')}"><i class="fa-solid fa-truck-fast"></i> سجل الطرود</a></li>
                <li><a href="purchases.html" class="${UI.isActive('purchases.html')}"><i class="fa-solid fa-cart-arrow-down"></i> المشتريات</a></li>
                <li><a href="expenses.html" class="${UI.isActive('expenses.html')}"><i class="fa-solid fa-money-bill-transfer"></i> المصروفات</a></li>
                <li><a href="suppliers.html" class="${UI.isActive('suppliers.html')}"><i class="fa-solid fa-handshake-angle"></i> الموردين</a></li>
                <li><a href="reports.html" class="${UI.isActive('reports.html')}"><i class="fa-solid fa-chart-column"></i> التقارير</a></li>
                <li style="margin-top: auto; border-top: 1px solid rgba(255,255,255,0.1);">
                    <a href="settings.html" class="${UI.isActive('settings.html')}"><i class="fa-solid fa-gears"></i> الإعدادات</a>
                </li>
            </ul>
        `;
        if (!document.querySelector('.sidebar')) {
            const sidebar = document.createElement('div');
            sidebar.className = 'sidebar';
            sidebar.innerHTML = sidebarHTML;
            document.body.prepend(sidebar);

            const main = document.querySelector('body > :not(.sidebar)');
            if (main) main.classList.add('main-content');
        }
    },

    isActive: (page) => {
        const path = window.location.pathname;
        return path.includes(page) ? 'active' : '';
    },

    getCurrencyOptions: () => {
        const currencies = store.getCurrencies();
        return currencies.map(c => `<option value="${c.code}">${c.name} (${c.symbol})</option>`).join('');
    },

    formatMoney: (amount, currencyCode) => {
        const c = store.getCurrencies().find(x => x.code === currencyCode) || { symbol: currencyCode };
        return `${parseFloat(amount).toLocaleString()} ${c.symbol}`;
    },

    printOrder: (id) => {
        const o = store.data.orders.find(ord => ord.id === id);
        if (!o) return;

        const brand = store.getBranding();
        const logoHtml = brand.logo
            ? `<img src="${brand.logo}" style="height:60px; width:auto; margin-bottom:10px;">`
            : '';
        const nameHtml = brand.name;

        const cust = store.data.customers.find(c => c.id === o.customerId) || { phone: '-', address: '-' };
        const items = o.cartItems || [];
        const itemsListHtml = items.map(item => {
            const itemImg = UI.getItemImage(item.name, item);
            return `
                <tr>
                    <td style="width:50px; text-align:center;">
                        ${itemImg ? `<img src="${itemImg}" style="width:40px; height:40px; object-fit:cover; border-radius:4px;">` : '🖼️'}
                    </td>
                    <td>${item.name}</td>
                    <td>1</td>
                    <td>${UI.formatMoney(item.price, o.currency)}</td>
                    <td>${UI.formatMoney(item.price, o.currency)}</td>
                </tr>
            `;
        }).join('') || `<tr><td colspan="5">${o.itemsText || '-'}</td></tr>`;
                

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(`
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>فاتورة - ${o.id}</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap');
                    * { box-sizing: border-box; }
                    html, body { direction: rtl !important; text-align: right !important; unicode-bidi: embed !important; }
                    body { font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif; padding: 40px; color: #333; margin: 0; }
                    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #333; padding-bottom: 20px; margin-bottom: 30px; }
                    .logo { font-size: 24px; font-weight: 900; }
                    .inv-info { text-align: left; }
                    .cust-info { margin-bottom: 30px; background: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; direction: rtl !important; }
                    th { background: #333; color: white; padding: 12px; text-align: right; }
                    td { padding: 12px; border-bottom: 1px solid #eee; text-align: right; }
                    .totals { width: 300px; margin-right: auto; }
                    .total-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #ddd; }
                    .grand { font-size: 20px; font-weight: 900; border-bottom: 2px solid #333; padding-top: 10px; }
                    @media print { .no-print { display: none; } }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="logo">
                        ${logoHtml}
                        <div style="font-size:24px; font-weight:900;">${nameHtml}</div>
                    </div>
                    <div class="inv-info">
                        <div style="font-weight:900; font-size:1.2rem;">فاتورة طلب #${o.id.substr(-8)}</div>
                        <div>التاريخ: ${new Date(o.createdAt).toLocaleDateString('ar-EG')}</div>
                    </div>
                </div>

                <div class="cust-info">
                    <div style="font-weight:900; margin-bottom:10px;">👤 معلومات العميل</div>
                    <div>الاسم: ${o.customerName}</div>
                    <div>الهاتف: ${cust.phone}</div>
                    <div>العنوان: ${cust.address}</div>
                </div>

                <table>
                    <thead>
                        <tr><th>الصورة</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr>
                    </thead>
                    <tbody>${itemsListHtml}</tbody>
                </table>

                <div class="no-print" style="margin-top:20px; display:flex; gap:10px; justify-content:center;">
                    <button onclick="window.print()" style="padding:10px 20px; background:var(--primary-color); color:white; border:none; border-radius:8px; cursor:pointer; font-weight:bold;">🖨️ طباعة الفاتورة</button>
                    <button onclick="window.close()" style="padding:10px 20px; background:#f1f5f9; color:#64748b; border:none; border-radius:8px; cursor:pointer; font-weight:bold;">إغلاق</button>
                </div>

                <div class="totals">
                    <div class="total-row"><span>المجموع الفرعي:</span> <span>${UI.formatMoney(o.subtotal || 0, o.currency)}</span></div>
                    <div class="total-row"><span>التوصيل:</span> <span>${UI.formatMoney(o.delivery || 0, o.currency)}</span></div>
                    <div class="total-row"><span>الخصم:</span> <span style="color:red;">-${UI.formatMoney(o.discount || 0, o.currency)}</span></div>
                    <div class="total-row grand"><span>الإجمالي:</span> <span>${UI.formatMoney(o.total, o.currency)}</span></div>
                </div>

                <div style="margin-top:50px; text-align:center; font-size:0.9rem; color:#888;">
                    شكراً لتعاملكم معنا!
                </div>

                <script>
                    window.onload = () => { window.print(); setTimeout(() => window.close(), 1000); };
                </script>
            </body>
            </html>
        `);
        printWindow.document.close();
    },

    printShipment: (id) => {
        const o = store.data.orders.find(ord => ord.id === id);
        const s = store.data.shipments.find(ship => ship.orderId === id);
        if (!o || !s) return;

        const brand = store.getBranding();
        const logoHtml = brand.logo
            ? `<img src="${brand.logo}" style="height:60px; width:auto; margin-bottom:10px;">`
            : '';

        const cust = store.data.customers.find(c => c.id === o.customerId) || { phone: '-', address: '-' };
        
        const printWindow = window.open('', '_blank', 'width=800,height=600');
        printWindow.document.write(`
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>بوليصة شحن - ${o.id}</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap');
                    * { box-sizing: border-box; }
                    html, body { direction: rtl !important; text-align: right !important; unicode-bidi: embed !important; }
                    body { font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif; padding: 30px; color: #1e293b; background: white; margin: 0; }
                    .ticket { border: 2px solid #e2e8f0; border-radius: 12px; padding: 25px; max-width: 600px; margin: auto; direction: rtl !important; }
                    .header { text-align: center; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; margin-bottom: 25px; }
                    .section { margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #f1f5f9; }
                    .section-title { font-weight: 900; color: #64748b; font-size: 0.8rem; margin-bottom: 10px; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; text-align: right; }
                    .info-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 1rem; }
                    .label { color: #64748b; }
                    .value { font-weight: 700; color: #0f172a; text-align: right; }
                    .collection-box { background: #eff6ff; border: 2px solid #3b82f6; padding: 20px; border-radius: 10px; text-align: center; margin-top: 25px; }
                    .collection-label { font-size: 1rem; font-weight: 700; color: #1e40af; }
                    .collection-amount { font-size: 2.2rem; font-weight: 900; color: #1e3a8a; display: block; }
                    @media print { .no-print { display: none; } }
                </style>
            </head>
            <body>
                <div class="ticket">
                    <div class="header">
                        ${logoHtml}
                        <div style="font-size:1.5rem; font-weight:900; color:#0f172a;">${brand.name}</div>
                        <div style="font-weight:700; color:#64748b;">بوليصة شحن (Delivery Ticket)</div>
                    </div>

                    <div class="section">
                        <div class="section-title">👤 معلومات المستلم (Customer)</div>
                        <div class="info-row"><span class="label">الاسم:</span> <span class="value">${o.customerName}</span></div>
                        <div class="info-row"><span class="label">الهاتف:</span> <span class="value">${cust.phone}</span></div>
                        <div class="info-row"><span class="label">العنوان:</span> <span class="value">${o.address || cust.address}</span></div>
                    </div>

                    <div class="section">
                        <div class="section-title">🚚 تفاصيل التوصيل (Shipping)</div>
                        <div class="info-row"><span class="label">رقم الطلب:</span> <span class="value">#${o.id.substr(-8)}</span></div>
                        <div class="info-row"><span class="label">شركة التوصيل:</span> <span class="value">${s.companyName}</span></div>
                        <div class="info-row"><span class="label">المنطقة:</span> <span class="value">${s.areaName}</span></div>
                        <div class="info-row"><span class="label">التاريخ:</span> <span class="value">${new Date(s.date).toLocaleDateString('ar-EG')}</span></div>
                    </div>

                    <div class="collection-box">
                        <span class="collection-label">💰 المبلغ المطلوب تحصيله (Total to Collect)</span>
                        <span class="collection-amount">${UI.formatMoney(o.total, o.currency)}</span>
                    </div>

                    <div style="margin-top:25px; text-align:center; font-size:0.8rem; color:#94a3b8; border-top:1px dashed #e2e8f0; padding-top:15px;">
                        يرجى التأكد من استلام الطرد بالحالة السليمة. شكراً لثقتكم!
                    </div>
                </div>

                <div class="no-print" style="margin-top:30px; text-align:center;">
                    <button onclick="window.print()" style="padding:12px 30px; background:#3b82f6; color:white; border:none; border-radius:8px; font-weight:900; cursor:pointer;">🖨️ طباعة الآن</button>
                    <button onclick="window.close()" style="margin-right:10px; padding:12px 30px; background:#f1f5f9; color:#64748b; border:none; border-radius:8px; font-weight:700; cursor:pointer;">إلغاء</button>
                </div>
            </body>
            </html>
        `);
        printWindow.document.close();
    }
};

// ✅ store MUST be created BEFORE UI.init(), because injectSidebar() calls store.getBranding()
const store = new AppStore();

// Expose globals for all page scripts
window.store = store;
window.UI = UI;

// Now initialize the UI (sidebar, modals, toasts)
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UI.init());
} else {
    UI.init();
}

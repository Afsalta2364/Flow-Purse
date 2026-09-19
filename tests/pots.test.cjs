const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Test the exact model shipped in the single-file app, without browser dependencies.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.match(/<script id="ledgerModel">([\s\S]*?)<\/script>/)[1];
const Ledger = new Function(`${source}\nreturn Ledger;`)();
const empty = () => ({ version: 2, pots: [], transactions: [] });
const pot = (id, rateBps, name = id) => ({ id, name, rateBps, color: 'sage' });
const entry = (id, amountCents, type = 'inflow', potId = null) => ({ id, desc: id, amountCents, type, potId, date: 'Scheduled' });
function reconciliation(state) {
  const result = Ledger.summarize(state);
  const balances = [...result.pots.values()].reduce((sum, value) => sum + value.balance, result.unallocated.balance);
  assert.equal(balances, result.net, 'All pot balances plus unallocated must equal the net balance');
  for (const item of state.transactions.filter(item => item.type === 'inflow')) {
    const split = result.allocations.get(item.id);
    assert.equal(split.reduce((sum, part) => sum + part.cents, 0), item.amountCents);
    assert.ok(split.every(part => Number.isSafeInteger(part.cents) && part.cents >= 0));
  }
  return result;
}

test('migrates existing entries without replacing them or assigning spending to a new pot', () => {
  const legacy = [{ id: 3, desc: 'Hosting', amount: 149.99, type: 'outflow', date: 'Upcoming' }];
  const state = Ledger.load(null, JSON.stringify(legacy));
  assert.equal(state.transactions[0].amountCents, 14999);
  assert.equal(state.transactions[0].potId, null);
  assert.equal(reconciliation(state).unallocated.balance, -14999);
  assert.deepEqual(Ledger.load(null, '[]').transactions, []);
});

test('allocates existing and new inflows using the current pot rules', () => {
  let state = Ledger.addEntry(empty(), entry('first', 100000));
  state = Ledger.savePot(state, pot('operations', 6000));
  state = Ledger.savePot(state, pot('savings', 2500));
  let result = reconciliation(state);
  assert.equal(result.pots.get('operations').balance, 60000);
  assert.equal(result.pots.get('savings').balance, 25000);
  assert.equal(result.unallocated.balance, 15000);
  state = Ledger.addEntry(state, entry('second', 40000));
  result = reconciliation(state);
  assert.equal(result.pots.get('operations').balance, 84000);
  assert.equal(result.pots.get('savings').balance, 35000);
  assert.equal(result.unallocated.balance, 21000);
});

test('rejects a combined rule above 100% without changing existing state', () => {
  const state = Ledger.savePot(empty(), pot('a', 6000));
  const before = JSON.stringify(state);
  assert.throws(() => Ledger.savePot(state, pot('b', 4001)), /more than 100%/);
  assert.equal(JSON.stringify(state), before);
  const full = Ledger.savePot(state, pot('b', 4000));
  assert.throws(() => Ledger.savePot(full, pot('a', 6001)), /more than 100%/);
  assert.equal(Ledger.ruleTotal(full.pots), 10000);
});

test('editing a percentage recalculates old income while preserving assigned expenses', () => {
  let state = Ledger.savePot(empty(), pot('operations', 5000));
  state = Ledger.addEntry(state, entry('income', 100000));
  state = Ledger.addEntry(state, entry('rent', 40000, 'outflow', 'operations'));
  state = Ledger.savePot(state, pot('operations', 2500));
  const result = reconciliation(state);
  assert.equal(result.pots.get('operations').funded, 25000);
  assert.equal(result.pots.get('operations').spent, 40000);
  assert.equal(result.pots.get('operations').balance, -15000);
  assert.equal(result.unallocated.balance, 75000);
  assert.equal(result.net, 60000);
});

test('assigning an outflow can overdraw a pot', () => {
  let state = Ledger.savePot(empty(), pot('operations', 2000));
  state = Ledger.addEntry(state, entry('income', 100000));
  state = Ledger.addEntry(state, entry('expense', 35000, 'outflow', 'operations'));
  assert.equal(reconciliation(state).pots.get('operations').balance, -15000);
});

test('unallocated outflows can exceed unallocated funds', () => {
  let state = Ledger.savePot(empty(), pot('savings', 10000));
  state = Ledger.addEntry(state, entry('income', 10000));
  state = Ledger.addEntry(state, entry('expense', 5000, 'outflow'));
  const result = reconciliation(state);
  assert.equal(result.unallocated.balance, -5000);
  assert.equal(result.pots.get('savings').balance, 10000);
});

test('reassigning an outflow refunds the old pot and deducts from the new one once', () => {
  let state = Ledger.savePot(empty(), pot('a', 6000));
  state = Ledger.savePot(state, pot('b', 4000));
  state = Ledger.addEntry(state, entry('income', 10000));
  state = Ledger.addEntry(state, entry('expense', 4500, 'outflow', 'a'));
  state = Ledger.assignOutflow(state, 'expense', 'b');
  let result = reconciliation(state);
  assert.equal(result.pots.get('a').balance, 6000);
  assert.equal(result.pots.get('b').balance, -500);
  state = Ledger.assignOutflow(state, 'expense', null);
  result = reconciliation(state);
  assert.equal(result.pots.get('b').balance, 4000);
  assert.equal(result.unallocated.balance, -4500);
  assert.equal(result.totalOut, 4500);
});

test('deleting an expense restores its pot balance', () => {
  let state = Ledger.savePot(empty(), pot('a', 10000));
  state = Ledger.addEntry(state, entry('income', 10000));
  state = Ledger.addEntry(state, entry('expense', 8000, 'outflow', 'a'));
  state = Ledger.removeEntry(state, 'expense');
  assert.equal(reconciliation(state).pots.get('a').balance, 10000);
});

test('deleting income removes its allocations without removing existing spending', () => {
  let state = Ledger.savePot(empty(), pot('a', 10000));
  state = Ledger.addEntry(state, entry('income', 10000));
  state = Ledger.addEntry(state, entry('expense', 8000, 'outflow', 'a'));
  state = Ledger.removeEntry(state, 'income');
  assert.equal(reconciliation(state).pots.get('a').balance, -8000);
});

test('removing a pot moves its expenses to unallocated and keeps other pot rules', () => {
  let state = Ledger.savePot(empty(), pot('a', 6000));
  state = Ledger.savePot(state, pot('b', 2500));
  state = Ledger.addEntry(state, entry('income', 10000));
  state = Ledger.addEntry(state, entry('expense', 3000, 'outflow', 'a'));
  state = Ledger.removePot(state, 'a');
  const result = reconciliation(state);
  assert.equal(state.transactions[0].potId, null);
  assert.equal(result.pots.get('b').balance, 2500);
  assert.equal(result.unallocated.balance, 4500);
  assert.equal(result.net, 7000);
});

test('clearing entries preserves rules and stays empty after saving and reloading', () => {
  let state = Ledger.savePot(empty(), pot('a', 5000));
  state = Ledger.addEntry(state, entry('income', 10000));
  state = Ledger.clearEntries(state);
  state = Ledger.load(JSON.stringify(state), null);
  assert.equal(state.pots[0].rateBps, 5000);
  assert.equal(state.transactions.length, 0);
  assert.equal(reconciliation(state).pots.get('a').balance, 0);
});

test('saved pot state round-trips without double-counting allocations', () => {
  let state = Ledger.savePot(empty(), pot('a', 3333));
  state = Ledger.addEntry(state, entry('income', 10001));
  state = Ledger.addEntry(state, entry('expense', 4999, 'outflow', 'a'));
  const result = reconciliation(state);
  for (let i = 0; i < 5; i++) state = Ledger.load(JSON.stringify(state), '[]');
  assert.deepEqual(reconciliation(state), result);
});

test('one-cent inflows never allocate more than one cent', () => {
  const rules = [pot('a', 3333), pot('b', 3333), pot('c', 3334)];
  assert.deepEqual(Ledger.allocate(1, rules), [{ potId: 'a', cents: 0 }, { potId: 'b', cents: 0 }, { potId: 'c', cents: 1 }, { potId: null, cents: 0 }]);
  assert.deepEqual(Ledger.allocate(1, [pot('a', 5000)]), [{ potId: 'a', cents: 1 }, { potId: null, cents: 0 }]);
});

test('rounding preserves every cent across small, ordinary, and very large inflows', () => {
  const ruleSets = [[], [pot('a', 0)], [pot('a', 10000)], [pot('a', 1250), pot('b', 3275)], [pot('a', 3333), pot('b', 3333), pot('c', 3334)]];
  for (const rules of ruleSets) {
    for (const cents of [1, 2, 3, 7, 99, 101, 10001, 9999999, Ledger.MAX_CENTS]) {
      const split = Ledger.allocate(cents, rules);
      assert.equal(split.reduce((sum, part) => sum + part.cents, 0), cents);
      assert.ok(split.every(part => Number.isSafeInteger(part.cents) && part.cents >= 0));
      const totalAssigned = split.filter(part => part.potId !== null).reduce((sum, part) => sum + part.cents, 0);
      assert.ok(totalAssigned <= cents);
      if (Ledger.ruleTotal(rules) === 10000) assert.equal(totalAssigned, cents);
    }
  }
});

test('a zero percent pot can hold assigned outflows and recover when its rule increases', () => {
  let state = Ledger.savePot(empty(), pot('a', 0));
  state = Ledger.addEntry(state, entry('income', 20000));
  state = Ledger.addEntry(state, entry('expense', 5000, 'outflow', 'a'));
  assert.equal(reconciliation(state).pots.get('a').balance, -5000);
  state = Ledger.savePot(state, pot('a', 5000));
  assert.equal(reconciliation(state).pots.get('a').balance, 5000);
});

test('money and percentage inputs reject negatives, excess precision, infinity, and missing values', () => {
  assert.equal(Ledger.parseMoney('10.29'), 1029);
  assert.equal(Ledger.parsePercent('33.33'), 3333);
  assert.equal(Ledger.parsePercent('0'), 0);
  for (const value of ['', '-1', '1.001', 'Infinity', 'NaN', '1e3']) {
    assert.throws(() => Ledger.parseMoney(value));
    assert.throws(() => Ledger.parsePercent(value));
  }
  assert.throws(() => Ledger.parseMoney('0'));
  assert.throws(() => Ledger.parsePercent('100.01'));
});

test('rejects invalid pot references and duplicate names', () => {
  let state = Ledger.savePot(empty(), pot('a', 10000, 'Savings'));
  assert.throws(() => Ledger.savePot(state, pot('b', 0, 'savings')), /already have/);
  assert.throws(() => Ledger.addEntry(state, entry('expense', 100, 'outflow', 'missing')));
  state = Ledger.addEntry(state, entry('income', 100));
  assert.throws(() => Ledger.assignOutflow(state, 'income', 'a'), /Choose an outflow/);
});

test('invalid stored data fails explicitly instead of silently replacing user entries', () => {
  assert.throws(() => Ledger.load('{invalid', '[]'));
  assert.throws(() => Ledger.load(JSON.stringify({ version: 3, pots: [], transactions: [] }), null));
});

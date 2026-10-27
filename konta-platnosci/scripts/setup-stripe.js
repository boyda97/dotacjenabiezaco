// Jednorazowo zakłada w Stripe produkty i ceny w PLN i wypisuje linie do .env.
// Uruchom: STRIPE_SECRET_KEY=sk_test_... npm run setup:stripe
// Można uruchomić ponownie – istniejące ceny są wyszukiwane po lookup_key.
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const WEEK_PLN = Number(process.env.WEEK_PRICE_PLN || 39);

// Ceny końcowe (tax_behavior: inclusive): sprzedawca jest zwolniony z VAT, więc klient płaci dokładnie tyle.
// Po przejściu na VAT kwota zostaje ceną brutto, chyba że utworzysz nowe ceny (lookup_key _v2).
const ITEMS = [
  { key: "start", name: "Dotacje na Bieżąco – abonament miesięczny", pln: 49, recurring: true },
  { key: "pro", name: "Dotacje na Bieżąco Pro", pln: 149, recurring: true },
  { key: "biuro", name: "Dotacje na Bieżąco Biuro", pln: 399, recurring: true },
  { key: "week", name: "Dotacje na Bieżąco – dostęp na 7 dni", pln: WEEK_PLN, recurring: false },
];

for (const it of ITEMS) {
  const lookup_key = `dnb_${it.key}_v1`;
  const found = await stripe.prices.list({ lookup_keys: [lookup_key], limit: 1 });
  let price = found.data[0];
  if (!price) {
    const product = await stripe.products.create({ name: it.name, metadata: { product: it.key } });
    price = await stripe.prices.create({
      product: product.id,
      currency: "pln",
      unit_amount: it.pln * 100,
      tax_behavior: "inclusive",
      lookup_key,
      ...(it.recurring ? { recurring: { interval: "month" } } : {}),
    });
  }
  console.log(`STRIPE_PRICE_${it.key.toUpperCase()}=${price.id}`);
}

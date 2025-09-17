# Sia CLI Tool

TypeScript-based transaction builder that generates unsigned Sia V2 transactions for hardware wallet signing.

## Setup

1. Install dependencies:
```bash
npm i
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Configure `.env`:
```
SIASCAN_API_BASE_URL=https://api.siascan.com
OUR_ADDRESS=your_sia_address_here
RECIPIENT_ADDRESS=recipient_sia_address_here
PUBLIC_KEY=your_ed25519_public_key_hex
```

## Usage

1. Set transaction amount in `src/build-transaction.ts`:
```typescript
const sendAmount = BigInt('2000000000000000000000000') // 2 SC
```

2. Run the transaction builder:
```bash
npx tsx ./src/build-transaction.ts
```

3. Copy the generated hex blob to the C signer
4. Paste the returned signature when prompted
5. Transaction will be broadcast to the network

## Transaction Blob Format

The generated blob contains binary-encoded transaction data:

| Field | Size | Encoding | Description |
|-------|------|----------|-------------|
| Input Count | 8 bytes | Little-endian uint64 | Number of UTXOs being spent |
| Parent IDs | 32 bytes each | Raw bytes | UTXO identifiers |
| Output Count | 8 bytes | Little-endian uint64 | Number of transaction outputs |
| Output Address | 32 bytes each | Raw bytes | Recipient address hash |
| Output Value Lo | 8 bytes each | Little-endian uint64 | Amount lower 64 bits |
| Output Value Hi | 8 bytes each | Little-endian uint64 | Amount upper 64 bits |
| Fee Lo | 8 bytes | Little-endian uint64 | Miner fee lower 64 bits |
| Fee Hi | 8 bytes | Little-endian uint64 | Miner fee upper 64 bits |

## Integration

This tool generates unsigned transactions for signing with the companion [Sia_Signing](https://github.com/Keyur279/Sia-Signing) C application.

## Currency Conversion

- 1 SC = 1e24 hastings

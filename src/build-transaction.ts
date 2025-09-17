import axios from 'axios'
import { config } from 'dotenv'
import * as readline from 'readline'

config()

interface UTXO {
  id: string
  siacoinOutput: {
    value: string
    address: string
  }
  maturityHeight: number
}

interface TransactionOutput {
  value: string
  address: string
}

async function waitForSignature(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })
    
    rl.question('Signature: ', (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function hexToBytes(hex: string): number[] {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = []
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes.push(parseInt(cleanHex.substr(i, 2), 16))
  }
  return bytes
}

function serializeTransactionBlob(
  selectedUTXOs: UTXO[], 
  outputs: TransactionOutput[], 
  fee: bigint
): string {
  const buffer: number[] = []
  
  // 1. Input count (8 bytes LE)
  const inputCount = BigInt(selectedUTXOs.length)
  for (let i = 0; i < 8; i++) {
    buffer.push(Number((inputCount >> BigInt(i * 8)) & 0xFFn))
  }
  
  // 2. Parent IDs (32 bytes each)
  for (const utxo of selectedUTXOs) {
    const parentBytes = hexToBytes(utxo.id)
    buffer.push(...parentBytes)
  }
  
  // 3. Output count (8 bytes LE)
  const outputCount = BigInt(outputs.length)
  for (let i = 0; i < 8; i++) {
    buffer.push(Number((outputCount >> BigInt(i * 8)) & 0xFFn))
  }
  
  // 4. Outputs (32 + 16 bytes each)
  for (const output of outputs) {
    // Address hash (first 64 chars = 32 bytes)
    const addrBytes = hexToBytes(output.address.substring(0, 64))
    buffer.push(...addrBytes)
    
    // Value as V2Currency (lo + hi, both 8 bytes LE)
    const value = BigInt(output.value)
    const lo = value & 0xFFFFFFFFFFFFFFFFn
    const hi = value >> 64n
    
    // Value lo (8 bytes LE)
    for (let i = 0; i < 8; i++) {
      buffer.push(Number((lo >> BigInt(i * 8)) & 0xFFn))
    }
    // Value hi (8 bytes LE)
    for (let i = 0; i < 8; i++) {
      buffer.push(Number((hi >> BigInt(i * 8)) & 0xFFn))
    }
  }
  
  // 5. Fee (16 bytes LE: lo + hi)
  const feeLo = fee & 0xFFFFFFFFFFFFFFFFn
  const feeHi = fee >> 64n
  
  // Fee lo (8 bytes LE)
  for (let i = 0; i < 8; i++) {
    buffer.push(Number((feeLo >> BigInt(i * 8)) & 0xFFn))
  }
  // Fee hi (8 bytes LE)
  for (let i = 0; i < 8; i++) {
    buffer.push(Number((feeHi >> BigInt(i * 8)) & 0xFFn))
  }
  
  // Convert to hex string
  return buffer.map(b => b.toString(16).padStart(2, '0')).join('')
}

async function fetchUTXOs(address: string) {
  const response = await axios.get(`${process.env.SIASCAN_API_BASE_URL}/wallet/api/addresses/${address}/outputs/siacoin`)
  return response.data
}

async function fetchNetworkData() {
  const [tipResponse, feeResponse] = await Promise.all([
    axios.get(`${process.env.SIASCAN_API_BASE_URL}/consensus/tip`),
    axios.get(`${process.env.SIASCAN_API_BASE_URL}/txpool/fee`)
  ])
  
  return {
    height: tipResponse.data.height,
    basis: tipResponse.data,
    feePerByte: BigInt(feeResponse.data)
  }
}

function selectCoins(utxos: UTXO[], targetAmount: bigint, feeAmount: bigint) {
  const needed = targetAmount + feeAmount
  
  // Sort UTXOs by value 
  const sortedUTXOs = utxos.sort((a, b) => {
    const valueA = BigInt(a.siacoinOutput.value)
    const valueB = BigInt(b.siacoinOutput.value)
    return Number(valueB - valueA)
  })
  
  let selected = []
  let total = 0n
  
  for (const utxo of sortedUTXOs) {
    selected.push(utxo)
    total += BigInt(utxo.siacoinOutput.value)
    
    if (total >= needed) {
      break
    }
  }
  
  if (total < needed) {
    throw new Error('Insufficient funds')
  }
  
  const change = total - needed
  return { selected, total, change }
}

async function broadcastTransaction(
  selectedUTXOs: UTXO[], 
  outputs: TransactionOutput[],
  fee: bigint,
  signature: string, 
  basis: any
) {
  const transaction = {
    siacoinInputs: selectedUTXOs.map(utxo => ({
      parent: utxo,
      satisfiedPolicy: {
        policy: {
          type: 'uc' as const,
          policy: {
            timelock: 0,
            publicKeys: [`ed25519:${process.env.PUBLIC_KEY}`],
            signaturesRequired: 1
          }
        },
        signatures: [signature],
        preimages: []
      }
    })),
    siacoinOutputs: outputs,
    minerFee: fee.toString()
  }

  console.log('Transaction object:', JSON.stringify(transaction, null, 2))

  const response = await axios.post(`${process.env.SIASCAN_API_BASE_URL}/txpool/broadcast`, {
    basis: basis,
    transactions: [],
    v2transactions: [transaction]
  })
  
  console.log('Broadcast status:', response.status)
  
  return response.status === 200
}

async function main() {
  console.log('=== Sia Transaction Builder ===')
  
  const ourAddress = process.env.OUR_ADDRESS!
  const recipientAddress = process.env.RECIPIENT_ADDRESS!
  const sendAmount = BigInt('2000000000000000000000000') // 2 SC
  
  const [utxoData, networkData] = await Promise.all([
    fetchUTXOs(ourAddress),
    fetchNetworkData()
  ])
  
  console.log(`Found ${utxoData.outputs.length} UTXOs`)
  console.log(`Current height: ${networkData.height}`)
  
  const matureUTXOs = utxoData.outputs.filter((utxo: UTXO) => 
    utxo.maturityHeight <= networkData.height
  )
  
  if (matureUTXOs.length === 0) {
    console.log('No mature UTXOs available')
    return
  }
  
  const estimatedFee = networkData.feePerByte * 1000n
  const selection = selectCoins(matureUTXOs, sendAmount, estimatedFee)
  
  console.log(`\nTransaction Details:`)
  console.log(`Inputs: ${selection.selected.length} UTXOs`)
  console.log(`Total input: ${Number(selection.total) / 1e24} SC`)
  console.log(`Send: ${Number(sendAmount) / 1e24} SC`)
  console.log(`Fee: ${Number(estimatedFee) / 1e24} SC`)
  console.log(`Change: ${Number(selection.change) / 1e24} SC`)
  
  const outputs: TransactionOutput[] = [
    {
      value: sendAmount.toString(),
      address: recipientAddress
    }
  ]
  
  if (selection.change > 0n) {
    outputs.push({
      value: selection.change.toString(),
      address: ourAddress
    })
  }
  
  const transactionBlob = serializeTransactionBlob(
    selection.selected,
    outputs,
    estimatedFee
  )
  
  console.log(`\n=== TRANSACTION BLOB FOR C PARSER ===`)
  console.log(transactionBlob)
  console.log(`\nCopy this hex to your C signer and paste the signature here:`)
  
  const signature = await waitForSignature()
  
  if (!signature) {
    console.log('No signature provided')
    return
  }
  
  console.log('\nBroadcasting transaction...')
  const freshUtxoData = await fetchUTXOs(ourAddress)
  try {
    const success = await broadcastTransaction(
      selection.selected,
      outputs,
      estimatedFee,
      signature,
      freshUtxoData.basis
    )
    
    if (success) {
      console.log('Transaction broadcast successfully!')
    } else {
      console.log('Broadcast failed')
    }
  } catch (error: any) {
    console.log('Broadcast error:', error.response?.data || error.message)
  }
}

main().catch(console.error)
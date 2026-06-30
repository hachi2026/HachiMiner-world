from web3 import Web3
import json

RPC = "https://worldchain-mainnet.g.alchemy.com/public"
TX  = "0xa95b8ebc58820282a3fb20aa8abc6faa1df6a8752ff2ab80e0d12f86c1ed3b01"

PRIZE_PAID_TOPIC = Web3.keccak(text="PrizePaid(address,uint256,uint256)").hex()

w3 = Web3(Web3.HTTPProvider(RPC))
print(f"Conectado: {w3.is_connected()}")

receipt = w3.eth.get_transaction_receipt(TX)
print(f"Bloque: {receipt['blockNumber']}")
print(f"Logs totales en tx: {len(receipt['logs'])}")
print()

events = []
for log in receipt["logs"]:
    if log["topics"] and log["topics"][0].hex() == PRIZE_PAID_TOPIC:
        # PrizePaid(address indexed user, uint256 amount, uint256 rank)
        # topics[1] = user (indexed), data = abi.encode(amount, rank)
        user   = "0x" + log["topics"][1].hex()[-40:]
        data   = log["data"].hex() if isinstance(log["data"], bytes) else log["data"]
        # strip 0x
        data   = data.replace("0x", "")
        amount_raw = int(data[:64], 16)
        rank_raw   = int(data[64:128], 16)
        amount_eth = amount_raw / 1e18
        events.append({"user": user, "amount": amount_eth, "rank": rank_raw})

events.sort(key=lambda x: x["rank"])

print(f"{'Rank':<6} {'Amount (HACHI)':<20} {'Address'}")
print("-" * 72)
for e in events:
    print(f"#{e['rank']:<5} {e['amount']:<20.4f} {e['user']}")

total = sum(e["amount"] for e in events)
print()
print(f"Total eventos PrizePaid: {len(events)}")
print(f"Total HACHI distribuido: {total:.4f}")
print(f"Coincide con 30,000: {'✓' if abs(total - 30000) < 1 else f'✗ (diferencia: {abs(total-30000):.4f})'}")

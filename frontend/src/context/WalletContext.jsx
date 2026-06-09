import { createContext, useContext, useState, useCallback } from 'react';
import { ethers } from 'ethers';

const WalletContext = createContext(null);

const POLYGON_CHAIN_ID = '0x89';        // 137 mainnet
const MUMBAI_CHAIN_ID = '0x13881';      // 80001 testnet

const TARGET_CHAIN = import.meta.env.VITE_USE_TESTNET === 'true' ? MUMBAI_CHAIN_ID : POLYGON_CHAIN_ID;
const TARGET_CHAIN_NAME = import.meta.env.VITE_USE_TESTNET === 'true' ? 'Polygon Mumbai' : 'Polygon';

const POLYGON_PARAMS = {
  chainId: POLYGON_CHAIN_ID,
  chainName: 'Polygon Mainnet',
  nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
  rpcUrls: ['https://polygon-rpc.com/'],
  blockExplorerUrls: ['https://polygonscan.com/'],
};

const MUMBAI_PARAMS = {
  chainId: MUMBAI_CHAIN_ID,
  chainName: 'Polygon Mumbai',
  nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
  rpcUrls: ['https://rpc-mumbai.maticvigil.com/'],
  blockExplorerUrls: ['https://mumbai.polygonscan.com/'],
};

export function WalletProvider({ children }) {
  const [account, setAccount] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [provider, setProvider] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState(null);

  const isCorrectNetwork = chainId === TARGET_CHAIN;

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError('MetaMask not detected. Please install MetaMask.');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const ethProvider = new ethers.BrowserProvider(window.ethereum);
      await ethProvider.send('eth_requestAccounts', []);
      const signer = await ethProvider.getSigner();
      const address = await signer.getAddress();
      const network = await ethProvider.getNetwork();
      const hexChainId = '0x' + network.chainId.toString(16);

      setProvider(ethProvider);
      setAccount(address);
      setChainId(hexChainId);

      if (hexChainId !== TARGET_CHAIN) {
        await switchToPolygon();
      }
    } catch (err) {
      setError(err.message || 'Failed to connect wallet');
    } finally {
      setConnecting(false);
    }
  }, []);

  const switchToPolygon = useCallback(async () => {
    if (!window.ethereum) return;
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: TARGET_CHAIN }],
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        const params = import.meta.env.VITE_USE_TESTNET === 'true' ? MUMBAI_PARAMS : POLYGON_PARAMS;
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [params],
        });
      } else {
        throw switchError;
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    setAccount(null);
    setChainId(null);
    setProvider(null);
  }, []);

  // Listen for account/network changes
  if (window.ethereum) {
    window.ethereum.on('accountsChanged', (accounts) => {
      setAccount(accounts[0] || null);
      if (!accounts[0]) disconnect();
    });
    window.ethereum.on('chainChanged', (id) => setChainId(id));
  }

  return (
    <WalletContext.Provider value={{
      account,
      chainId,
      provider,
      connecting,
      error,
      isCorrectNetwork,
      targetChainName: TARGET_CHAIN_NAME,
      connect,
      disconnect,
      switchToPolygon,
    }}>
      {children}
    </WalletContext.Provider>
  );
}

export const useWallet = () => useContext(WalletContext);

import React, {createContext, useCallback, useContext, useRef, useState} from 'react';

interface AppContextValue {
  apiUrl: string;
  setApiUrl: (url: string) => void;
  exitSession: () => void;
  setExitSession: (fn: () => void) => void;
  isDemoMode: boolean;
  setIsDemoMode: (v: boolean) => void;
}

const AppContext = createContext<AppContextValue>({
  apiUrl: 'http://192.168.0.70:8000',
  setApiUrl: () => {},
  exitSession: () => {},
  setExitSession: () => {},
  isDemoMode: false,
  setIsDemoMode: () => {},
});

export const AppContextProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [apiUrl, setApiUrl] = useState('http://10.36.29.176:8000');
  const [isDemoMode, setIsDemoMode] = useState(false);
  const exitSessionRef = useRef<() => void>(() => {});
  const exitSession = useCallback(() => exitSessionRef.current(), []);
  const setExitSession = useCallback((fn: () => void) => {
    exitSessionRef.current = fn;
  }, []);

  return (
    <AppContext.Provider value={{apiUrl, setApiUrl, exitSession, setExitSession, isDemoMode, setIsDemoMode}}>
      {children}
    </AppContext.Provider>
  );
};

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}

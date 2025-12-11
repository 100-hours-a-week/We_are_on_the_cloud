import { createContext, useState, useEffect, useCallback, useRef, useContext } from 'react';
import { useRouter } from 'next/router';
import socketService from '../services/socket';
import authService from '../services/authService';

const AuthContext = createContext(null);

/**
 * useAuth Hook - AuthContext를 사용하기 위한 커스텀 훅
 */
export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return context;
};

const SESSION_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours
const TOKEN_VERIFICATION_INTERVAL = 5 * 60 * 1000; // 5 minutes

/**
 * AuthProvider: 전역 인증 상태 관리
 *
 * 제공하는 상태:
 * - user: 현재 로그인한 사용자 정보
 * - isAuthenticated: 인증 여부
 * - isLoading: 인증 상태 확인 중 여부
 *
 * 제공하는 메서드:
 * - login: 로그인 처리
 * - logout: 로그아웃 처리
 * - register: 회원가입 처리
 * - updateProfile: 프로필 업데이트
 * - updateUser: 사용자 정보 직접 업데이트 (프로필 이미지 등)
 */
export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const sessionCheckInterval = useRef(null);

    // localStorage에서 사용자 정보 로드
    const loadUserFromStorage = useCallback(() => {
        try {
            if (typeof window === 'undefined') return null;

            const userStr = localStorage.getItem('user');
            if (!userStr) return null;

            const userData = JSON.parse(userStr);

            // 세션 타임아웃 체크
            if (Date.now() - userData.lastActivity > SESSION_TIMEOUT) {
                localStorage.removeItem('user');
                return null;
            }

            // 활동 시간 업데이트
            userData.lastActivity = Date.now();
            localStorage.setItem('user', JSON.stringify(userData));

            return userData;
        } catch (error) {
            console.error('Failed to load user from storage:', error);
            localStorage.removeItem('user');
            return null;
        }
    }, []);

    // 사용자 정보를 localStorage와 state에 저장
    const saveUser = useCallback((userData) => {
        if (!userData) {
            localStorage.removeItem('user');
            setUser(null);
            return;
        }

        const userToSave = {
            ...userData,
            lastActivity: Date.now()
        };

        localStorage.setItem('user', JSON.stringify(userToSave));
        setUser(userToSave);
    }, []);

    // 세션 타임아웃 체크 (백그라운드)
    useEffect(() => {
        if (!user) {
            if (sessionCheckInterval.current) {
                clearInterval(sessionCheckInterval.current);
                sessionCheckInterval.current = null;
            }
            return;
        }

        // 5분마다 세션 타임아웃 체크
        sessionCheckInterval.current = setInterval(() => {
            const currentUser = loadUserFromStorage();
            if (!currentUser) {
                // 세션 만료됨
                setUser(null);
                socketService.disconnect();
                router.replace('/');
            }
        }, 5 * 60 * 1000);

        return () => {
            if (sessionCheckInterval.current) {
                clearInterval(sessionCheckInterval.current);
            }
        };
    }, [user, loadUserFromStorage, router]);

    // 초기 로드
    useEffect(() => {
        const userData = loadUserFromStorage();
        setUser(userData);
        setIsLoading(false);
    }, [loadUserFromStorage]);

    // 로그인 (API 호출 + 상태 저장)
    const login = useCallback(async (credentials) => {
        const userData = await authService.login(credentials);
        saveUser(userData);
        return userData;
    }, [saveUser]);

    // 로그아웃 (API 호출 + 상태 정리)
    const logout = useCallback(async () => {
        try {
            // authService를 통해 로그아웃 API 호출
            await authService.logout(user?.token, user?.sessionId);
        } catch (error) {
            console.error('Logout error:', error);
        } finally {
            // 소켓 연결 해제
            socketService.disconnect();

            // 로컬 상태 정리
            saveUser(null);

            // 로그인 페이지로 이동
            router.push('/');
        }
    }, [user, saveUser, router]);

    // 회원가입
    const register = useCallback(async (userData) => {
        const registeredUser = await authService.register(userData);
        return registeredUser;
    }, []);

    // 프로필 업데이트 (API 호출 + 상태 저장)
    const updateProfile = useCallback(async (updates) => {
        if (!user) return;

        const updatedUserData = await authService.updateProfile(
            updates,
            user.token,
            user.sessionId
        );

        const updatedUser = {
            ...user,
            ...updatedUserData,
            token: user.token,
            sessionId: user.sessionId,
            lastActivity: Date.now()
        };

        saveUser(updatedUser);
        return updatedUser;
    }, [user, saveUser]);

    // 사용자 정보 직접 업데이트 (외부에서 사용)
    const updateUser = useCallback((userData) => {
        if (!userData) {
            saveUser(null);
            return;
        }

        const updatedUser = {
            ...user,
            ...userData,
            lastActivity: Date.now()
        };

        saveUser(updatedUser);
    }, [user, saveUser]);

    // 토큰 검증
    const verifyToken = useCallback(async () => {
        try {
            if (!user?.token || !user?.sessionId) {
                throw new Error('No authentication data found');
            }

            // 마지막 검증 시간 확인
            const lastVerification = localStorage.getItem('lastTokenVerification');
            if (lastVerification && Date.now() - parseInt(lastVerification) < TOKEN_VERIFICATION_INTERVAL) {
                return true;
            }

            // authService를 통해 토큰 검증 (API 호출)
            const API_URL = process.env.NEXT_PUBLIC_API_URL;
            const response = await fetch(`${API_URL}/api/auth/verify-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': user.token,
                    'x-session-id': user.sessionId
                },
                credentials: 'include'
            });

            const data = await response.json();

            if (data.success) {
                localStorage.setItem('lastTokenVerification', Date.now().toString());
                return true;
            }

            throw new Error(data.message || '토큰 검증에 실패했습니다.');
        } catch (error) {
            if (error.response?.status === 401) {
                try {
                    await refreshToken();
                    localStorage.setItem('lastTokenVerification', Date.now().toString());
                    return true;
                } catch (refreshError) {
                    await logout();
                    throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
                }
            }
            throw error;
        }
    }, [user]);

    // 토큰 갱신
    const refreshToken = useCallback(async () => {
        try {
            if (!user?.token) {
                throw new Error('인증 정보가 없습니다.');
            }

            const API_URL = process.env.NEXT_PUBLIC_API_URL;
            const response = await fetch(`${API_URL}/api/auth/refresh-token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-token': user.token,
                    'x-session-id': user.sessionId
                },
                credentials: 'include'
            });

            const data = await response.json();

            if (data.success && data.token) {
                const updatedUser = {
                    ...user,
                    token: data.token,
                    lastActivity: Date.now()
                };
                saveUser(updatedUser);
                return data.token;
            }

            throw new Error('토큰 갱신에 실패했습니다.');
        } catch (error) {
            console.error('Token refresh error:', error);
            throw error;
        }
    }, [user, saveUser]);

    const value = {
        user,
        isAuthenticated: !!user,
        isLoading,
        login,
        logout,
        register,
        updateProfile,
        updateUser,
        verifyToken,
        refreshToken
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
};

/**
 * withAuth HOC - 인증이 필요한 페이지를 보호
 *
 * AuthContext를 사용하여 인증 상태를 확인하고,
 * 인증되지 않은 사용자를 로그인 페이지로 리다이렉트
 */
export const withAuth = (WrappedComponent) => {
    const WithAuthComponent = (props) => {
        const router = useRouter();
        const { isAuthenticated, isLoading } = useAuth();

        useEffect(() => {
            if (!isLoading && !isAuthenticated) {

                // 🔥 register, login, landing 페이지는 redirect 금지
                const publicPages = ['/', '/register', '/login'];
                if (!publicPages.includes(router.pathname)) {
                    router.replace('/?redirect=' + router.asPath);
                }
            }
        }, [isAuthenticated, isLoading, router]);

        // 로딩 중이거나 인증되지 않은 경우 로딩 화면 표시
        if (isLoading || !isAuthenticated) {
            return (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    backgroundColor: 'var(--vapor-color-background)',
                    color: 'var(--vapor-color-text-primary)'
                }}>
                    <div>Loading...</div>
                </div>
            );
        }

        return <WrappedComponent {...props} />;
    };

    // HOC에 displayName 설정
    const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';
    WithAuthComponent.displayName = `WithAuth(${displayName})`;

    return WithAuthComponent;
};

/**
 * withoutAuth HOC - 인증되지 않은 사용자만 접근 가능 (로그인/회원가입)
 *
 * 이미 로그인한 사용자는 /chat으로 리다이렉트
 */
export const withoutAuth = (WrappedComponent) => {
    const WithoutAuthComponent = (props) => {
        const router = useRouter();
        const { isAuthenticated, isLoading } = useAuth();

        useEffect(() => {
            // 라우터가 준비되고 로딩이 끝났을 때
            if (router.isReady && !isLoading && isAuthenticated) {
                // 이미 로그인된 사용자는 채팅 페이지로 리다이렉트
                router.replace('/chat');
            }
        }, [isAuthenticated, isLoading, router, router.isReady]);

        // 로딩 중이거나 이미 로그인된 사용자인 경우 로딩 화면
        if (isLoading || isAuthenticated) {
            return (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100vh',
                    backgroundColor: 'var(--vapor-color-background)',
                    color: 'var(--vapor-color-text-primary)'
                }}>
                    <div>Loading...</div>
                </div>
            );
        }

        return <WrappedComponent {...props} />;
    };

    const displayName = WrappedComponent.displayName || WrappedComponent.name || 'Component';
    WithoutAuthComponent.displayName = `WithoutAuth(${displayName})`;

    return WithoutAuthComponent;
};

export default AuthContext;
